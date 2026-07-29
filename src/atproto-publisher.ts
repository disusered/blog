import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";

import { asDatetimeString, isUriString } from "@atproto/lex";

import type { Main as LinkedClaim } from "./lexicons/com/linkedclaims/claim.defs.ts";
import { main as linkedClaim } from "./lexicons/com/linkedclaims/claim.defs.ts";

export const PUBLICATION_ENVELOPE_SCHEMA = "polychrome.publication-envelope.v1";
export const PUBLIC_CLAIM_SCHEMA = "polychrome.public-claim.v1";
export const ATPROTO_RECEIPT_SCHEMA = "polychrome.atproto.receipt.v1";
export const LINKED_CLAIMS_COLLECTION = "com.linkedclaims.claim";
export const ATPROTO_CREATE_SCOPE =
  "atproto repo:com.linkedclaims.claim?action=create";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const PRIVATE_MARKERS = [
  "/home/",
  "polychrome://black",
  "polychrome://marginalia",
  "../black",
  "../marginalia",
  "source_revisions",
  "%polychrome:",
  "<!-- polychrome:",
];

export interface PublicEvidence {
  uri: string;
}

export interface PublicClaimPayload {
  schemaVersion: typeof PUBLIC_CLAIM_SCHEMA;
  kind: "recognition" | "pathway";
  subject: string;
  title: string;
  summary: string;
  statement: string;
  tags: string[];
  evidence: PublicEvidence[];
  createdAt: string;
}

export interface PublicationEnvelope {
  schemaVersion: typeof PUBLICATION_ENVELOPE_SCHEMA;
  edition: {
    id: string;
    revision: string;
  };
  channel: "atproto";
  preparedAt: string;
  payload: PublicClaimPayload;
  payloadSha256: string;
  envelopeSha256: string;
}

export interface AtprotoReceipt {
  schemaVersion: typeof ATPROTO_RECEIPT_SCHEMA;
  status: "published";
  channel: "atproto";
  editionId: string;
  editionRevision: string;
  payloadSha256: string;
  envelopeSha256: string;
  uri: string;
  cid: string;
  did: string;
  publishedAt: string;
}

export type ClaimRecord = Omit<LinkedClaim, "$type">;

export interface ClaimPublisher {
  did: string;
  create(
    record: ClaimRecord,
    rkey: string,
  ): Promise<{ uri: string; cid: string }>;
  get(rkey: string): Promise<{ uri: string; cid: string; value: LinkedClaim }>;
}

export interface PublishResult {
  uri: string;
  cid: string;
  did: string;
  rkey: string;
  reused: boolean;
}

export async function readPublicationEnvelope(
  path: string,
): Promise<PublicationEnvelope> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Publication envelope must be a non-symlink regular file.");
  }
  if (metadata.size > MAX_INPUT_BYTES) {
    throw new Error("Publication envelope exceeds the 8 MiB limit.");
  }
  const bytes = await readFile(path);
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  return validatePublicationEnvelope(value);
}

export function validatePublicationEnvelope(
  value: unknown,
): PublicationEnvelope {
  const envelope = objectValue(value, "publication envelope");
  exactString(
    envelope.schemaVersion,
    PUBLICATION_ENVELOPE_SCHEMA,
    "publication envelope schemaVersion",
  );
  exactString(envelope.channel, "atproto", "publication envelope channel");
  timestamp(envelope.preparedAt, "publication envelope preparedAt");

  const edition = objectValue(envelope.edition, "publication envelope edition");
  const editionId = stringValue(edition.id, "publication envelope edition.id");
  if (!editionId.startsWith("red:")) {
    throw new Error("Publication envelope edition.id must start with red:.");
  }
  sha256Value(edition.revision, "publication envelope edition.revision");

  const payload = validatePublicClaimPayload(envelope.payload);
  const payloadSha256 = sha256Value(
    envelope.payloadSha256,
    "publication envelope payloadSha256",
  );
  if (sha256(payload) !== payloadSha256) {
    throw new Error("Publication envelope payload hash does not match.");
  }
  const envelopeSha256 = sha256Value(
    envelope.envelopeSha256,
    "publication envelope envelopeSha256",
  );
  const envelopeCore = { ...envelope };
  delete envelopeCore.envelopeSha256;
  if (sha256(envelopeCore) !== envelopeSha256) {
    throw new Error("Publication envelope hash does not match.");
  }
  rejectPrivateReferences(envelope);
  return envelope as unknown as PublicationEnvelope;
}

export function toLinkedClaim(envelope: PublicationEnvelope): ClaimRecord {
  const payload = envelope.payload;
  const statement = [payload.summary, payload.statement]
    .filter(Boolean)
    .join("\n\n");
  const record: ClaimRecord = {
    subject: linkedClaimsUri(payload.subject),
    claimType: payload.kind,
    object: payload.title,
    statement,
    evidence: payload.evidence.map(({ uri }) => ({
      uri: linkedClaimsUri(uri),
    })),
    createdAt: asDatetimeString(payload.createdAt),
  };
  linkedClaim.build(record);
  return record;
}

export function deterministicRecordKey(envelope: PublicationEnvelope): string {
  const digest = envelope.envelopeSha256.replace(/^sha256:/, "");
  return `${envelope.payload.kind}-${digest.slice(0, 24)}`;
}

export async function publishClaim(
  publisher: ClaimPublisher,
  envelope: PublicationEnvelope,
): Promise<PublishResult> {
  if (!publisher.did.startsWith("did:")) {
    throw new Error("Authenticated AT Protocol identity is not a DID.");
  }
  const record = toLinkedClaim(envelope);
  const typedRecord = linkedClaim.build(record);
  const rkey = deterministicRecordKey(envelope);
  try {
    const created = await publisher.create(record, rkey);
    return {
      ...created,
      did: publisher.did,
      rkey,
      reused: false,
    };
  } catch (createError) {
    try {
      const existing = await publisher.get(rkey);
      if (canonicalJson(existing.value) !== canonicalJson(typedRecord)) {
        throw new Error(
          "Deterministic AT Protocol record key already contains different content.",
        );
      }
      return {
        uri: existing.uri,
        cid: existing.cid,
        did: publisher.did,
        rkey,
        reused: true,
      };
    } catch (getError) {
      if (
        getError instanceof Error &&
        getError.message.includes("already contains different content")
      ) {
        throw getError;
      }
      throw createError;
    }
  }
}

export function publicationReceipt(
  envelope: PublicationEnvelope,
  result: PublishResult,
  publishedAt = new Date().toISOString(),
): AtprotoReceipt {
  timestamp(publishedAt, "publisher receipt publishedAt");
  return {
    schemaVersion: ATPROTO_RECEIPT_SCHEMA,
    status: "published",
    channel: "atproto",
    editionId: envelope.edition.id,
    editionRevision: envelope.edition.revision,
    payloadSha256: envelope.payloadSha256,
    envelopeSha256: envelope.envelopeSha256,
    uri: result.uri,
    cid: result.cid,
    did: result.did,
    publishedAt,
  };
}

export async function writeReceipt(
  path: string,
  receipt: AtprotoReceipt,
): Promise<"created" | "unchanged"> {
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  try {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(bytes, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    return "created";
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("Existing publisher receipt is not a regular file.");
    }
    const existing = await readFile(path, "utf8");
    if (existing !== bytes) {
      throw new Error(
        "Publisher receipt path already contains different content.",
      );
    }
    return "unchanged";
  }
}

export async function readExistingReceipt(
  path: string,
  envelope: PublicationEnvelope,
): Promise<AtprotoReceipt | null> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Existing publisher receipt is not a regular file.");
  }
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  const receipt = validateReceipt(value);
  for (const [field, expected] of [
    ["editionId", envelope.edition.id],
    ["editionRevision", envelope.edition.revision],
    ["payloadSha256", envelope.payloadSha256],
    ["envelopeSha256", envelope.envelopeSha256],
  ] as const) {
    if (receipt[field] !== expected) {
      throw new Error(
        `Existing publisher receipt ${field} does not match the envelope.`,
      );
    }
  }
  return receipt;
}

export function validateReceipt(value: unknown): AtprotoReceipt {
  const receipt = objectValue(value, "publisher receipt");
  exactString(
    receipt.schemaVersion,
    ATPROTO_RECEIPT_SCHEMA,
    "publisher receipt schemaVersion",
  );
  exactString(receipt.status, "published", "publisher receipt status");
  exactString(receipt.channel, "atproto", "publisher receipt channel");
  stringValue(receipt.editionId, "publisher receipt editionId");
  sha256Value(receipt.editionRevision, "publisher receipt editionRevision");
  sha256Value(receipt.payloadSha256, "publisher receipt payloadSha256");
  sha256Value(receipt.envelopeSha256, "publisher receipt envelopeSha256");
  const uri = stringValue(receipt.uri, "publisher receipt uri");
  if (!uri.startsWith("at://")) {
    throw new Error("Publisher receipt uri must be an AT URI.");
  }
  stringValue(receipt.cid, "publisher receipt cid");
  const did = stringValue(receipt.did, "publisher receipt did");
  if (!did.startsWith("did:")) {
    throw new Error("Publisher receipt did must be a DID.");
  }
  timestamp(receipt.publishedAt, "publisher receipt publishedAt");
  return receipt as unknown as AtprotoReceipt;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function validatePublicClaimPayload(value: unknown): PublicClaimPayload {
  const payload = objectValue(value, "public claim payload");
  exactString(
    payload.schemaVersion,
    PUBLIC_CLAIM_SCHEMA,
    "public claim schemaVersion",
  );
  if (payload.kind !== "recognition" && payload.kind !== "pathway") {
    throw new Error("Public claim kind must be recognition or pathway.");
  }
  uri(
    stringValue(payload.subject, "public claim subject"),
    "public claim subject",
  );
  stringValue(payload.title, "public claim title");
  stringValue(payload.summary, "public claim summary");
  const statement = textValue(payload.statement, "public claim statement");
  if (statement.length > 10_000) {
    throw new Error("Public claim statement exceeds 10,000 characters.");
  }
  if (
    !Array.isArray(payload.tags) ||
    !payload.tags.every((tag) => typeof tag === "string")
  ) {
    throw new Error("Public claim tags must be an array of strings.");
  }
  if (!Array.isArray(payload.evidence)) {
    throw new Error("Public claim evidence must be an array.");
  }
  for (const item of payload.evidence) {
    const evidence = objectValue(item, "public claim evidence item");
    const evidenceUri = stringValue(evidence.uri, "public claim evidence uri");
    if (!/^https?:\/\//.test(evidenceUri)) {
      throw new Error("Public claim evidence must use an HTTP(S) URI.");
    }
  }
  timestamp(payload.createdAt, "public claim createdAt");
  return payload as unknown as PublicClaimPayload;
}

function rejectPrivateReferences(value: unknown): void {
  if (typeof value === "string") {
    const lowered = value.toLowerCase();
    if (PRIVATE_MARKERS.some((marker) => lowered.includes(marker))) {
      throw new Error(
        "Publication envelope contains a private-store reference.",
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) rejectPrivateReferences(item);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) rejectPrivateReferences(item);
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new Error(`${label} must be a non-empty safe string.`);
  }
  return value;
}

function textValue(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return (
        (code < 32 && character !== "\n" && character !== "\t") || code === 127
      );
    })
  ) {
    throw new Error(`${label} must be non-empty safe text.`);
  }
  return value;
}

function exactString(value: unknown, expected: string, label: string): void {
  if (value !== expected) {
    throw new Error(`${label} must be ${expected}.`);
  }
}

function sha256Value(value: unknown, label: string): string {
  const digest = stringValue(value, label);
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`${label} must be a SHA-256 digest.`);
  }
  return digest;
}

function timestamp(value: unknown, label: string): string {
  const date = stringValue(value, label);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      date,
    ) ||
    Number.isNaN(Date.parse(date))
  ) {
    throw new Error(`${label} must be an RFC 3339 timestamp.`);
  }
  return date;
}

function uri(value: string, label: string): void {
  try {
    new URL(value);
  } catch {
    throw new Error(`${label} must be a URI.`);
  }
}

function linkedClaimsUri(value: string): LinkedClaim["subject"] {
  if (!isUriString(value)) {
    throw new Error("LinkedClaims URI did not pass AT Protocol validation.");
  }
  return value;
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function isNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
