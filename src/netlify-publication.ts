import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonical, sha256 } from "./publication-hash.ts";
import {
  canonicalUrl,
  publicUrl,
  type PublicationEnvelope,
} from "./publication.ts";
import type { BuildProfile } from "./publication-build.ts";

type Deploy = {
  id: string;
  site_id: string;
  state: string;
  deploy_ssl_url?: string;
  deploy_url?: string;
  required?: string[];
};
type Site = {
  id: string;
  ssl_url: string;
  custom_domain?: string;
  domain_aliases?: string[];
  build_settings?: { repo_url?: string; stop_builds?: boolean };
};
type Fetch = typeof fetch;

export function netlifyApi(token: string, fetcher: Fetch = fetch) {
  if (!token)
    throw new Error("Configure NETLIFY_AUTH_TOKEN for website publication.");
  return async function request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const response = await fetcher(`https://api.netlify.com/api/v1${path}`, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: {
        "content-type": "application/json",
        ...options.headers,
        authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok)
      throw new Error(
        `Netlify ${options.method ?? "GET"} failed (${response.status}).`,
      );
    const body = await response.text();
    return JSON.parse(body || "null");
  };
}

export async function preflight(
  siteId: string,
  profile: BuildProfile,
  token: string,
  fetcher: Fetch = fetch,
) {
  if (!/^[a-zA-Z0-9-]+$/.test(siteId))
    throw new Error("Configure a Netlify site ID.");
  const site = await netlifyApi(token, fetcher)<Site>(`/sites/${siteId}`);
  const host = publicUrl(profile.url).hostname;
  if (
    site.id !== siteId ||
    ![
      site.custom_domain,
      ...(site.domain_aliases ?? []),
      new URL(site.ssl_url).hostname,
    ].includes(host)
  )
    throw new Error(
      "The Netlify site does not serve this publication's domain.",
    );
  if (site.build_settings?.repo_url && site.build_settings.stop_builds !== true)
    throw new Error(
      "Stop Netlify Git builds for this site before enabling Portal publication; otherwise a Git build can overwrite published writing.",
    );
  return { ready: true, siteId: site.id, url: profile.url };
}

export async function verifyPublication(
  envelope: PublicationEnvelope,
  baseUrl: string,
  fetcher: Fetch = fetch,
) {
  const origin = publicUrl(baseUrl).origin;
  const [page, feed] = await Promise.all([
    fetcher(`${origin}/blog/${envelope.payload.slug}/`, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    }),
    fetcher(`${origin}/rss.xml`, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    }),
  ]);
  if (!page.ok || !feed.ok)
    throw new Error("The public page or RSS is not available yet.");
  const [html, xml] = await Promise.all([page.text(), feed.text()]);
  const marker = envelope.payloadSha256;
  const item = xml
    .match(/<item>[\s\S]*?<\/item>/g)
    ?.find((entry) => entry.includes(`<link>${canonicalUrl(envelope)}</link>`));
  if (
    !new RegExp(
      `<meta(?=[^>]*name=["']polychrome-publication["'])(?=[^>]*content=["']${marker}["'])[^>]*>`,
    ).test(html) ||
    !item?.includes(`<polychrome:hash>${marker}</polychrome:hash>`)
  )
    throw new Error(
      "The page and RSS do not contain the approved publication.",
    );
}

async function save(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}`;
  await writeFile(temporary, canonical(value), { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

/** Create a draft, verify it, then make that exact deploy public. Portal serializes by site. */
export async function deployFiles(options: {
  siteId: string;
  profile: BuildProfile;
  files: Map<string, Buffer>;
  stateDir: string;
  token: string;
  verify: (url: string) => Promise<void>;
  fetcher?: Fetch;
}) {
  const {
    siteId,
    profile,
    files,
    stateDir,
    token,
    verify,
    fetcher = fetch,
  } = options;
  await preflight(siteId, profile, token, fetcher);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const stat = await lstat(stateDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
    throw new Error("Publication delivery state must be a private directory.");
  const digests = Object.fromEntries(
    [...files]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, data]) => [
        path,
        createHash("sha1").update(data).digest("hex"),
      ]),
  );
  const statePath = join(
    stateDir,
    `${sha256(canonical({ siteId, digests }))}.json`,
  );
  const api = netlifyApi(token, fetcher);
  let deploy: Deploy | undefined;
  try {
    const saved = JSON.parse(await readFile(statePath, "utf8")) as {
      deployId: string;
    };
    if (!/^[a-zA-Z0-9-]+$/.test(saved.deployId))
      throw new Error("Invalid saved deployment.");
    deploy = await api<Deploy>(`/sites/${siteId}/deploys/${saved.deployId}`);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  if (!deploy) {
    deploy = await api<Deploy>(`/sites/${siteId}/deploys`, {
      method: "POST",
      body: JSON.stringify({ files: digests, draft: true }),
    });
    await save(statePath, { deployId: deploy.id });
  }
  if (deploy.site_id !== siteId || !/^[a-zA-Z0-9-]+$/.test(deploy.id))
    throw new Error("Netlify returned another site's deploy.");
  for (const digest of deploy.required ?? []) {
    const path = Object.keys(digests).find((key) => digests[key] === digest);
    if (!path) throw new Error("Netlify requested a file outside this build.");
    await api(
      `/deploys/${deploy.id}/files${path.split("/").map(encodeURIComponent).join("/")}`,
      {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: new Uint8Array(files.get(path)!),
      },
    );
  }
  for (
    let attempts = 0;
    !["ready", "current"].includes(deploy.state);
    attempts++
  ) {
    if (deploy.state === "error" || attempts >= 30)
      throw new Error("Netlify deployment is not ready; retry this delivery.");
    await delay(1000);
    deploy = await api<Deploy>(`/sites/${siteId}/deploys/${deploy.id}`);
  }
  const previewUrl = deploy.deploy_ssl_url || deploy.deploy_url;
  if (!previewUrl)
    throw new Error("Netlify did not return a deploy preview URL.");
  await verify(previewUrl);
  if (deploy.state !== "current")
    await api(`/sites/${siteId}/deploys/${deploy.id}/restore`, {
      method: "POST",
    });
  await verify(profile.url);
  return deploy.id;
}
