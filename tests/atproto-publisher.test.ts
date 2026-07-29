import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ATPROTO_CREATE_SCOPE,
  canonicalJson,
  deterministicRecordKey,
  publicationReceipt,
  publishClaim,
  readPublicationEnvelope,
  sha256,
  toLinkedClaim,
  validatePublicationEnvelope,
  writeReceipt,
  type ClaimPublisher,
  type PublicationEnvelope,
  type PublicClaimPayload,
} from "../src/atproto-publisher.ts";
import { main as linkedClaim } from "../src/lexicons/com/linkedclaims/claim.defs.ts";

function envelope(
  overrides: Partial<PublicClaimPayload> = {},
): PublicationEnvelope {
  const payload: PublicClaimPayload = {
    schemaVersion: "polychrome.public-claim.v1",
    kind: "recognition",
    subject: "https://example.test/learning",
    title: "Learning in public",
    summary: "An evidence-backed recognition.",
    statement:
      "Carlos learned how descriptive pathways model real work.\nThe claim remains evidence-backed.",
    tags: ["learning"],
    evidence: [{ uri: "https://example.test/evidence" }],
    createdAt: "2026-07-28T10:05:00-07:00",
    ...overrides,
  };
  const core = {
    schemaVersion: "polychrome.publication-envelope.v1" as const,
    edition: {
      id: "red:learning",
      revision: `sha256:${"a".repeat(64)}`,
    },
    channel: "atproto" as const,
    preparedAt: "2026-07-28T10:05:00-07:00",
    payload,
    payloadSha256: sha256(payload),
  };
  return {
    ...core,
    envelopeSha256: sha256(core),
  };
}

test("validates the revision-bound envelope and builds a LinkedClaims record", () => {
  const input = validatePublicationEnvelope(envelope());
  const record = toLinkedClaim(input);

  assert.deepEqual(record, {
    subject: "https://example.test/learning",
    claimType: "recognition",
    object: "Learning in public",
    statement:
      "An evidence-backed recognition.\n\nCarlos learned how descriptive pathways model real work.\nThe claim remains evidence-backed.",
    evidence: [{ uri: "https://example.test/evidence" }],
    createdAt: "2026-07-28T10:05:00-07:00",
  });
  assert.match(deterministicRecordKey(input), /^recognition-[a-f0-9]{24}$/);
  assert.equal(
    ATPROTO_CREATE_SCOPE,
    "atproto repo:com.linkedclaims.claim?action=create",
  );
});

test("rejects tampering and private-store references", () => {
  const tampered = envelope();
  tampered.payload.statement = "Changed after approval.";
  assert.throws(
    () => validatePublicationEnvelope(tampered),
    /payload hash does not match/,
  );

  const privateEnvelope = envelope({
    statement: "Derived from polychrome://black/private-entry.",
  });
  assert.throws(
    () => validatePublicationEnvelope(privateEnvelope),
    /private-store reference/,
  );
});

test("publishes with a deterministic record key", async () => {
  const input = envelope();
  const calls: string[] = [];
  const publisher: ClaimPublisher = {
    did: "did:plc:example",
    async create(record, rkey) {
      calls.push(rkey);
      assert.equal(record.claimType, "recognition");
      return {
        uri: `at://did:plc:example/com.linkedclaims.claim/${rkey}`,
        cid: "bafyreicreated",
      };
    },
    async get() {
      throw new Error("get should not be called");
    },
  };

  const result = await publishClaim(publisher, input);

  assert.equal(calls.length, 1);
  assert.equal(result.reused, false);
  assert.equal(result.rkey, deterministicRecordKey(input));
});

test("recovers an identical record after an indeterminate create failure", async () => {
  const input = envelope();
  const record = linkedClaim.build(toLinkedClaim(input));
  const publisher: ClaimPublisher = {
    did: "did:plc:example",
    async create() {
      throw new Error("connection ended before the create response");
    },
    async get(rkey) {
      return {
        uri: `at://did:plc:example/com.linkedclaims.claim/${rkey}`,
        cid: "bafyreiexisting",
        value: record,
      };
    },
  };

  const result = await publishClaim(publisher, input);

  assert.equal(result.reused, true);
  assert.equal(result.cid, "bafyreiexisting");
});

test("refuses a deterministic key collision with different content", async () => {
  const input = envelope();
  const different = linkedClaim.build({
    ...toLinkedClaim(input),
    statement: "Different public claim.",
  });
  const publisher: ClaimPublisher = {
    did: "did:plc:example",
    async create() {
      throw new Error("record exists");
    },
    async get(rkey) {
      return {
        uri: `at://did:plc:example/com.linkedclaims.claim/${rkey}`,
        cid: "bafyreiother",
        value: different,
      };
    },
  };

  await assert.rejects(
    publishClaim(publisher, input),
    /already contains different content/,
  );
});

test("writes a receipt without overwriting and accepts an exact retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atproto-publisher-"));
  const path = join(directory, "receipt.json");
  const input = envelope();
  const receipt = publicationReceipt(
    input,
    {
      uri: `at://did:plc:example/com.linkedclaims.claim/${deterministicRecordKey(input)}`,
      cid: "bafyreiexample",
      did: "did:plc:example",
      rkey: deterministicRecordKey(input),
      reused: false,
    },
    "2026-07-28T10:06:00-07:00",
  );
  try {
    assert.equal(await writeReceipt(path, receipt), "created");
    assert.equal(await writeReceipt(path, receipt), "unchanged");
    await assert.rejects(
      writeReceipt(path, { ...receipt, cid: "bafyreidifferent" }),
      /different content/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("will not read an envelope through a symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atproto-envelope-"));
  const target = join(directory, "target.json");
  const link = join(directory, "link.json");
  try {
    await writeFile(target, `${canonicalJson(envelope())}\n`);
    await symlink(target, link);
    await assert.rejects(
      readPublicationEnvelope(link),
      /non-symlink regular file/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
