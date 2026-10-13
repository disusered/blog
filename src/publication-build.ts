import { publicFiles } from "../scripts/publish-blog.ts";
import { canonical } from "./publication-hash.ts";
import {
  publicationKey,
  validateEnvelope,
  type PublicationEnvelope,
  type PublicationProfile,
  type PublicationSnapshot,
} from "./publication.ts";

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
      entry.payload.feedPresentation !== undefined
        ? entry.payload.destinations.includes("website")
        : entry.payload.destinations.includes("atproto"),
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
