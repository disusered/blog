import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonical,
  publicFiles,
  stage,
  type Envelope,
} from "../scripts/publish-blog.ts";

function envelope(body = "A public post.\n"): Envelope {
  const digest = (value: unknown) =>
    createHash("sha256").update(canonical(value)).digest("hex");
  const payload = {
    schemaVersion: "polychrome.public-post.v1",
    slug: "example",
    title: "Example",
    description: "A test",
    pubDate: "2026-09-05",
    tags: [],
    body,
    assets: [],
  };
  const core = {
    schemaVersion: "polychrome.publication-envelope.v1",
    channel: "blog",
    edition: { id: "red:example", revision: "sha256:private-revision" },
    preparedAt: "2026-09-05T00:00:00Z",
    payload,
    payloadSha256: digest(payload),
  };
  return { ...core, envelopeSha256: digest(core) };
}

test("export selects public fields and binds the publication marker", () => {
  const input = envelope();
  const files = publicFiles(input);
  const markdown = files.get("src/content/blog/example.md")!.toString();
  assert.match(markdown, new RegExp(input.payloadSha256));
  assert.doesNotMatch(
    markdown,
    /red:example|private-revision|preparedAt|sources/,
  );
  assert.throws(
    () => publicFiles({ ...input, payloadSha256: "tampered" }),
    /Invalid publication envelope/,
  );
  assert.throws(
    () => publicFiles(envelope("[Private](polychrome://black/entry)")),
    /Private references/,
  );
});

test("dry run writes nothing, repeated staging is unchanged, conflicts are refused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "blog-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await stage(envelope(), root)).outcome, "preview");
  await assert.rejects(readFile(join(root, "src/content/blog/example.md")), {
    code: "ENOENT",
  });
  assert.equal((await stage(envelope(), root, true)).outcome, "staged");
  assert.equal((await stage(envelope(), root, true)).outcome, "unchanged");
  await assert.rejects(
    stage(envelope("Changed"), root, true),
    /already differs/,
  );
});
