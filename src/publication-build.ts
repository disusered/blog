import { execFile } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { publicFiles } from "../scripts/publish-blog.ts";
import { canonical } from "./publication-hash.ts";
import {
  publicationKey,
  validateEnvelope,
  type PublicationEnvelope,
  type PublicationProfile,
  type PublicationSnapshot,
} from "./publication.ts";

const exec = promisify(execFile);
export type BuildProfile = Omit<PublicationProfile, "did"> & { did?: string };

export function snapshotFiles(
  snapshot: PublicationSnapshot,
  current: PublicationEnvelope,
) {
  validateEnvelope(current);
  if (
    snapshot.schemaVersion !== "polychrome.publication-snapshot.v1" ||
    snapshot.publication !== current.payload.publication.id
  )
    throw new Error("Select the approved snapshot for this publication.");
  const files = new Map<string, Buffer>();
  const slugs = new Set<string>();
  let containsCurrent = false;
  for (const envelope of snapshot.envelopes) {
    validateEnvelope(envelope);
    const profile = envelope.payload.publication;
    if (
      profile.id !== snapshot.publication ||
      profile.url !== current.payload.publication.url ||
      profile.did !== current.payload.publication.did
    )
      throw new Error("A public snapshot cannot contain another identity.");
    if (slugs.has(envelope.payload.slug))
      throw new Error(
        "A snapshot must select one approved version per permalink.",
      );
    slugs.add(envelope.payload.slug);
    containsCurrent ||= envelope.envelopeSha256 === current.envelopeSha256;
    for (const [path, bytes] of publicFiles(envelope)) {
      if (files.has(path)) throw new Error("Conflicting snapshot paths.");
      files.set(path, bytes);
    }
  }
  if (!containsCurrent)
    throw new Error(
      "The current approved revision is missing from the public snapshot.",
    );
  if (
    snapshot.envelopes.some((entry) =>
      entry.payload.destinations.includes("atproto"),
    )
  ) {
    const profile = current.payload.publication;
    files.set(
      "public/.well-known/site.standard.publication",
      Buffer.from(
        `at://${profile.did}/site.standard.publication/${publicationKey(profile)}`,
      ),
    );
  }
  return files;
}

export function metadataFiles(
  metadata: Record<string, unknown> | undefined,
  profile: BuildProfile,
) {
  const files = new Map<string, Buffer>();
  if (!metadata) return files;
  const clientId = new URL(String(metadata.client_id));
  if (clientId.origin !== profile.url) return files;
  if (
    clientId.pathname !== "/oauth-client-metadata.json" ||
    clientId.search ||
    clientId.hash
  )
    throw new Error(
      "Use /oauth-client-metadata.json on the public metadata host.",
    );
  const jwks = metadata.jwks as
    { keys?: Record<string, unknown>[] } | undefined;
  if (
    !jwks?.keys?.length ||
    jwks.keys.some((key) =>
      ["d", "p", "q", "dp", "dq", "qi", "k"].some((field) => field in key),
    )
  )
    throw new Error("Client metadata must contain public signing keys only.");
  files.set(
    "public/oauth-client-metadata.json",
    Buffer.from(canonical(metadata)),
  );
  files.set(
    "public/_headers",
    Buffer.from(
      "/oauth-client-metadata.json\n  Content-Type: application/json\n  Cache-Control: public, max-age=300\n",
    ),
  );
  return files;
}

async function collect(
  root: string,
  prefix = "",
): Promise<Map<string, Buffer>> {
  const found = new Map<string, Buffer>();
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = join(prefix, entry.name);
    if (entry.isSymbolicLink())
      throw new Error("Build output cannot contain symlinks.");
    if (entry.isDirectory())
      for (const item of await collect(root, path)) found.set(...item);
    else if (entry.isFile())
      found.set(`/${path}`, await readFile(join(root, path)));
  }
  return found;
}

/** A disposable build sees only the selected public snapshot and public template. */
export async function buildPublication(
  template: string,
  profile: BuildProfile,
  files: Map<string, Buffer>,
): Promise<Map<string, Buffer>> {
  const directory = await mkdtemp(join(tmpdir(), "red-publication-"));
  try {
    for (const path of [
      "src",
      "public",
      "astro.config.mjs",
      "package.json",
      "tsconfig.json",
    ])
      await cp(join(template, path), join(directory, path), {
        recursive: true,
        dereference: false,
      });
    if (profile.url !== "https://disusered.com") {
      await rm(join(directory, "src/content/blog"), { recursive: true });
      await rm(join(directory, "src/pages/about.astro"));
      await rm(join(directory, "public"), { recursive: true });
      await mkdir(join(directory, "public"));
      await cp(
        join(template, "public/favicon.ico"),
        join(directory, "public/favicon.ico"),
      );
    }
    // Source presence is not publication approval. Preserve only verified legacy posts.
    const legacy = JSON.parse(
      await readFile(join(template, "legacy-publications.json"), "utf8"),
    ) as Record<string, string[]>;
    const published = new Set(legacy[profile.url] ?? []);
    const contentRoot = join(directory, "src/content/blog");
    await mkdir(contentRoot, { recursive: true });
    for (const name of await readdir(contentRoot, { recursive: true })) {
      if (!/\.mdx?$/.test(name)) continue;
      const path = join(contentRoot, name);
      const content = await readFile(path, "utf8");
      if (
        !published.has(name.replace(/\.mdx?$/, "")) ||
        /^standardDocument:/m.test(content)
      )
        await rm(path);
    }
    for (const [path, bytes] of files) {
      const target = join(directory, path);
      if (path.startsWith("src/content/blog/")) {
        try {
          await lstat(target);
          throw new Error(
            `The permalink collides with existing writing: ${path}`,
          );
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ENOENT"
          )
            throw error;
        }
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
    await symlink(
      join(template, "node_modules"),
      join(directory, "node_modules"),
      "dir",
    );
    try {
      await exec(
        process.execPath,
        [join(template, "node_modules/.bin/astro"), "build"],
        {
          cwd: directory,
          env: {
            ...process.env,
            PUBLICATION_PROFILE_JSON: JSON.stringify(profile),
            ASTRO_TELEMETRY_DISABLED: "1",
          },
          timeout: 180_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      );
    } catch (error) {
      throw new Error(
        "The public website build failed; no deployment was attempted.",
        { cause: error },
      );
    }
    return await collect(join(directory, "dist"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
