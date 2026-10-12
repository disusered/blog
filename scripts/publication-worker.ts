import { dirname, join, resolve } from "node:path";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildRecords } from "../src/publication-records.ts";
import {
  buildPublication,
  metadataFiles,
  snapshotFiles,
  type BuildProfile,
} from "../src/publication-build.ts";
import {
  deployFiles,
  preflight,
  verifyPublication,
} from "../src/netlify-publication.ts";
import { canonical } from "../src/publication-hash.ts";
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

export async function operate(input: Request) {
  if (
    !input ||
    !["build-records", "website", "preflight", "bootstrap-metadata"].includes(
      input.action,
    )
  )
    throw new Error("Select a supported publication action.");
  if (input.action === "build-records") return buildRecords(input.envelope);
  if (!/^[a-zA-Z0-9-]+$/.test(input.siteId))
    throw new Error("Configure a Netlify site ID.");
  const token = process.env.NETLIFY_AUTH_TOKEN ?? "";
  const stateDir = process.env.BLOG_PUBLICATION_STATE_DIR;
  const profile =
    input.action === "website"
      ? input.envelope.payload.publication
      : input.profile;
  if (input.action === "preflight")
    return preflight(input.siteId, profile, token);
  if (!stateDir)
    throw new Error(
      "Configure BLOG_PUBLICATION_STATE_DIR for resumable website delivery.",
    );
  const files =
    input.action === "website"
      ? snapshotFiles(input.snapshot, input.envelope)
      : new Map<string, Buffer>();
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const stat = await lstat(stateDir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077)
    throw new Error("Publication delivery state must be a private directory.");
  const receiptPath =
    input.action === "website"
      ? join(
          stateDir,
          `receipt-${input.siteId}-${input.envelope.envelopeSha256}.json`,
        )
      : undefined;
  if (receiptPath) {
    try {
      const saved = JSON.parse(await readFile(receiptPath, "utf8"));
      if (
        input.action !== "website" ||
        saved.envelopeSha256 !== input.envelope.envelopeSha256
      )
        throw new Error("Invalid saved publication receipt.");
      await verifyPublication(input.envelope, profile.url);
      return saved;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
  } else {
    const prior = await readdir(stateDir).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    if (prior.some((name) => name.startsWith(`receipt-${input.siteId}-`)))
      throw new Error(
        "This site already has published Red writing. Refresh metadata through a complete publication snapshot.",
      );
  }
  const metadata = metadataFiles(input.metadata, profile);
  if (input.action === "bootstrap-metadata" && !metadata.size)
    throw new Error(
      "Provide this public host's OAuth metadata to bootstrap it.",
    );
  for (const entry of metadata) files.set(...entry);
  const template = dirname(dirname(fileURLToPath(import.meta.url)));
  const built = await buildPublication(template, profile, files);
  const verify =
    input.action === "website"
      ? (url: string) => verifyPublication(input.envelope, url)
      : async (url: string) => {
          const response = await fetch(
            new URL("/oauth-client-metadata.json", url),
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
  const deployId = await deployFiles({
    siteId: input.siteId,
    profile,
    files: built,
    stateDir,
    token,
    verify,
  });
  if (input.action !== "website")
    return {
      outcome: "published",
      deployId,
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
    pageVerified: true,
    rssVerified: true,
  };
  const temporary = `${receiptPath}.${randomUUID()}`;
  await writeFile(temporary, canonical(receipt), { mode: 0o600, flag: "wx" });
  await rename(temporary, receiptPath!);
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
