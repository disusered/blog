import { join, resolve } from "node:path";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { buildRecords } from "../src/publication-records.ts";
import {
  metadataFiles,
  snapshotFiles,
  type BuildProfile,
} from "../src/publication-build.ts";
import {
  preflight,
  verifyPublication,
  waitForPublication,
} from "../src/netlify-publication.ts";
import { publisherGit } from "../src/git-publication.ts";
import { canonical, sha256 } from "../src/publication-hash.ts";
import {
  canonicalUrl,
  type PublicationEnvelope,
  type PublicationSnapshot,
} from "../src/publication.ts";

type Request =
  | {
      action: "build-records";
      envelope: PublicationEnvelope;
    }
  | {
      action: "website";
      envelope: PublicationEnvelope;
      snapshot: PublicationSnapshot;
      siteId: string;
      metadata?: Record<string, unknown>;
    }
  | {
      action: "preflight" | "bootstrap-metadata";
      siteId: string;
      profile: BuildProfile;
      metadata?: Record<string, unknown>;
    };

async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
    throw new Error("Publication delivery state must be a private directory.");
}

async function readJson(path: string) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function saveJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}`;
  await writeFile(temporary, canonical(value), { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

/**
 * Website delivery commits public files to the site's repository and lets
 * Netlify's Git build deploy them, so the repository is the complete record.
 */
export async function operate(input: Request) {
  if (
    !input ||
    !["build-records", "website", "preflight", "bootstrap-metadata"].includes(
      input.action,
    )
  )
    throw new Error("Select a supported publication action.");
  if (input.action === "build-records") return buildRecords(input.envelope);
  if (
    input.action === "website" &&
    !input.envelope.payload.destinations.includes("website")
  )
    throw new Error("Website delivery was not selected.");
  if (!/^[a-zA-Z0-9-]+$/.test(input.siteId))
    throw new Error("Configure a Netlify site ID.");
  const token = process.env.NETLIFY_AUTH_TOKEN ?? "";
  const stateDir = process.env.BLOG_PUBLICATION_STATE_DIR;
  const key = process.env.PUBLICATION_GIT_KEY;
  const profile =
    input.action === "website"
      ? input.envelope.payload.publication
      : input.profile;
  const site = await preflight(input.siteId, profile, token);
  if (input.action === "preflight") return site;
  if (!stateDir)
    throw new Error(
      "Configure BLOG_PUBLICATION_STATE_DIR for resumable website delivery.",
    );
  await privateDirectory(stateDir);
  if (!key) throw new Error("Configure PUBLICATION_GIT_KEY for publication.");
  const keyStat = await lstat(key);
  if (!keyStat.isFile() || keyStat.mode & 0o077)
    throw new Error("The publication Git key must be a private file.");

  const files =
    input.action === "website"
      ? snapshotFiles(input.snapshot, input.envelope)
      : new Map<string, Buffer>();
  for (const entry of metadataFiles(input.metadata, profile))
    files.set(...entry);
  if (input.action === "bootstrap-metadata" && !files.size)
    throw new Error(
      "Provide this public host's OAuth metadata to bootstrap it.",
    );

  const identity =
    input.action === "website"
      ? input.envelope.envelopeSha256
      : sha256(canonical(input.metadata));
  const receiptPath = join(
    stateDir,
    `receipt-${input.siteId}-${identity}.json`,
  );
  const saved = await readJson(receiptPath);
  if (saved && input.action === "website") {
    if (saved.envelopeSha256 !== input.envelope.envelopeSha256)
      throw new Error("Invalid saved publication receipt.");
    await verifyPublication(input.envelope, profile.url);
    return saved;
  }

  const verify =
    input.action === "website"
      ? () => verifyPublication(input.envelope, profile.url)
      : async () => {
          const response = await fetch(
            new URL("/oauth-client-metadata.json", profile.url),
            { redirect: "error", signal: AbortSignal.timeout(30_000) },
          );
          if (
            !response.ok ||
            canonical(await response.json()) !== canonical(input.metadata)
          )
            throw new Error(
              "The deployed public OAuth metadata does not match.",
            );
        };

  const repository = site.repository;
  const git = publisherGit({
    clone: join(stateDir, "repositories", input.siteId),
    key,
  });
  const commitPath = join(stateDir, `commit-${input.siteId}-${identity}.json`);
  let commit: string | undefined = (await readJson(commitPath))?.commit;
  if (!commit || !(await git.published(commit, repository))) {
    const message =
      input.action === "website"
        ? `feat(content): publish ${input.envelope.payload.slug}`
        : "chore(publication): publish OAuth client metadata";
    for (let attempt = 0; !commit; attempt++) {
      if (attempt >= 3)
        throw new Error(
          "The repository kept moving during publication; retry this delivery.",
        );
      const head = await git.sync(repository);
      await git.write(files);
      const created = await git.commit([...files.keys()], message);
      if (!created) commit = head;
      else if (await git.push(repository)) commit = created;
    }
    await saveJson(commitPath, { commit });
  }

  const deployId = await waitForPublication({
    siteId: input.siteId,
    commit,
    verify,
    token,
  });
  if (input.action !== "website")
    return {
      outcome: "published",
      deployId,
      commit,
      clientId: input.metadata?.client_id,
    };
  const receipt = {
    schemaVersion: "polychrome.publication.receipt.v2",
    destination: "website",
    editionId: input.envelope.edition.id,
    editionRevision: input.envelope.edition.revision,
    envelopeSha256: input.envelope.envelopeSha256,
    payloadSha256: input.envelope.payloadSha256,
    uri: canonicalUrl(input.envelope),
    publishedAt: new Date().toISOString(),
    deployId,
    commit,
    pageVerified: true,
    rssVerified: true,
  };
  await saveJson(receiptPath, receipt);
  return receipt;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    let source = "";
    for await (const chunk of process.stdin) {
      source += chunk;
      if (Buffer.byteLength(source) > 128 * 1024 * 1024)
        throw new Error("The publication request exceeds 128 MiB.");
    }
    process.stdout.write(
      JSON.stringify(await operate(JSON.parse(source))) + "\n",
    );
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Publication failed.",
      }) + "\n",
    );
    process.exitCode = 1;
  }
}
