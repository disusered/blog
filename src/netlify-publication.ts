import { setTimeout as delay } from "node:timers/promises";
import { repositoryFor } from "./git-publication.ts";
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
  commit_ref?: string | null;
  context?: string;
};
type Site = {
  id: string;
  ssl_url: string;
  custom_domain?: string;
  domain_aliases?: string[];
  build_settings?: {
    repo_url?: string;
    repo_branch?: string;
    stop_builds?: boolean;
  };
  published_deploy?: { id: string };
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
  if (!site.build_settings?.repo_url || site.build_settings.stop_builds)
    throw new Error(
      "Link this Netlify site to its Git repository and enable builds before publishing.",
    );
  return {
    ready: true,
    siteId: site.id,
    url: profile.url,
    repository: repositoryFor(
      site.build_settings.repo_url,
      site.build_settings.repo_branch,
    ),
  };
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

/** Wait until Netlify builds the pushed commit and the canonical home serves it. */
export async function waitForPublication(options: {
  siteId: string;
  commit: string;
  verify: () => Promise<void>;
  token: string;
  fetcher?: Fetch;
  attempts?: number;
  interval?: number;
}) {
  const {
    siteId,
    commit,
    verify,
    token,
    fetcher = fetch,
    attempts = 50,
    interval = 10_000,
  } = options;
  const api = netlifyApi(token, fetcher);
  for (let attempt = 0; ; attempt++) {
    const deploys = await api<Deploy[]>(`/sites/${siteId}/deploys?per_page=20`);
    const build = deploys.find(
      (deploy) =>
        deploy.commit_ref === commit && deploy.context === "production",
    );
    if (build?.state === "error")
      throw new Error(
        "Netlify could not build the publication commit. Check the site's deploy log.",
      );
    try {
      await verify();
      const site = await api<Site>(`/sites/${siteId}`);
      return build?.id ?? site.published_deploy?.id ?? commit;
    } catch (error) {
      if (attempt >= attempts) throw error;
    }
    await delay(interval);
  }
}
