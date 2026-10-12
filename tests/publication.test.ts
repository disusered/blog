import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, sha256 } from "../src/publication-hash.ts";
import { buildRecords } from "../src/publication-records.ts";
import {
  buildPublication,
  metadataFiles,
  snapshotFiles,
} from "../src/publication-build.ts";
import {
  deployFiles,
  preflight,
  verifyPublication,
} from "../src/netlify-publication.ts";
import {
  canonicalUrl,
  type PublicPost,
  type PublicationEnvelope,
} from "../src/publication.ts";

export function envelope(
  changes: Partial<PublicPost> = {},
  revision = "a",
): PublicationEnvelope {
  const payload: PublicPost = {
    schemaVersion: "polychrome.public-post.v2",
    publication: {
      id: "carlos",
      name: "Carlos",
      url: "https://writer.example",
      did: "did:plc:aaaaaaaaaaaaaaaaaaaaaaaa",
    },
    media: "note",
    slug: "a-note",
    title: "A note",
    description: "My observation",
    pubDate: "2026-10-12",
    tags: [],
    body: "Here is something **interesting**.\n\nAnother paragraph.",
    assets: [],
    blueskyText: "Interesting 🐈 https://example.org/article",
    destinations: ["website", "atproto", "bluesky"],
    ...changes,
  };
  const core = {
    schemaVersion: "polychrome.publication-envelope.v2" as const,
    channel: "publication" as const,
    edition: { id: "red:a-note", revision: `sha256:${revision.repeat(64)}` },
    preparedAt: "2026-10-12T12:34:56.000Z",
    payload,
    payloadSha256: sha256(canonical(payload)),
  };
  return { ...core, envelopeSha256: sha256(canonical(core)) };
}

test("full writing and exact short text produce valid records with stable identity keys", async () => {
  const first = await buildRecords(envelope());
  const repeated = await buildRecords(envelope());
  assert.deepEqual(repeated, first);
  assert.match(first.document.record.textContent!, /something interesting/);
  assert.match(first.document.record.textContent!, /Another paragraph/);
  assert.doesNotMatch(first.document.record.textContent!, /\*\*/);
  assert.equal(first.bluesky!.record.text, envelope().payload.blueskyText);
  const facet = first.bluesky!.record.facets![0]!;
  assert.equal(
    Buffer.from(first.bluesky!.record.text)
      .subarray(facet.index.byteStart, facet.index.byteEnd)
      .toString(),
    "https://example.org/article",
  );
  for (const item of Object.values(first))
    assert.match(
      item.rkey,
      /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/,
    );
  const corrected = await buildRecords(
    envelope({ body: "A correction." }, "b"),
  );
  assert.equal(corrected.document.rkey, first.document.rkey);
  assert.notEqual(corrected.bluesky!.rkey, first.bluesky!.rkey);
  const secondIdentity = await buildRecords(
    envelope({
      publication: {
        ...envelope().payload.publication,
        id: "other",
        url: "https://other.example",
      },
    }),
  );
  assert.notEqual(secondIdentity.document.rkey, first.document.rkey);
});

test("Bluesky never silently truncates and content tampering is refused", async () => {
  await assert.rejects(
    buildRecords(envelope({ blueskyText: "x".repeat(301) })),
  );
  const changed = envelope();
  changed.payload.body = "Unexpected content";
  await assert.rejects(buildRecords(changed), /Invalid approved/);
  const noSocial = await buildRecords(
    envelope({ destinations: ["website", "atproto"], blueskyText: undefined }),
  );
  assert.equal(noSocial.bluesky, undefined);
});

test("snapshots bind one identity and approved revision, and export only public data", () => {
  const input = envelope();
  const snapshot = {
    schemaVersion: "polychrome.publication-snapshot.v1" as const,
    publication: "carlos",
    envelopes: [input],
  };
  const files = snapshotFiles(snapshot, input);
  const markdown = files.get("src/content/blog/a-note.md")!.toString();
  assert.match(markdown, /standardDocument: "at:\/\//);
  assert.doesNotMatch(
    markdown,
    /red:a-note|editionRevision|sources|envelopeSha256/,
  );
  assert.throws(
    () => snapshotFiles({ ...snapshot, envelopes: [] }, input),
    /missing/,
  );
  assert.throws(
    () => snapshotFiles({ ...snapshot, envelopes: [input, input] }, input),
    /one approved/,
  );
  assert.throws(
    () =>
      snapshotFiles(
        {
          ...snapshot,
          envelopes: [
            envelope({
              publication: { ...input.payload.publication, id: "other" },
            }),
          ],
        },
        input,
      ),
    /another identity/,
  );
});

test("public OAuth metadata excludes private keys and stays on its configured host", () => {
  const profile = envelope().payload.publication;
  const metadata = {
    client_id: "https://writer.example/oauth-client-metadata.json",
    jwks: { keys: [{ kty: "EC", x: "x", y: "y" }] },
  };
  assert.equal(metadataFiles(metadata, profile).size, 2);
  assert.equal(
    metadataFiles(metadata, { ...profile, url: "https://other.example" }).size,
    0,
  );
  assert.throws(
    () =>
      metadataFiles(
        { ...metadata, jwks: { keys: [{ d: "private" }] } },
        profile,
      ),
    /public signing keys/,
  );
});

test("page verification requires the matching RSS item as well as HTML", async () => {
  const input = envelope();
  const mockFetch: typeof fetch = async (url) =>
    new Response(
      String(url).endsWith("rss.xml")
        ? `<rss><item><link>${canonicalUrl(input)}</link><polychrome:hash>${input.payloadSha256}</polychrome:hash></item></rss>`
        : `<html><meta name="polychrome-publication" content="${input.payloadSha256}"></html>`,
    );
  await verifyPublication(input, "https://preview.example", mockFetch);
  await assert.rejects(
    verifyPublication(
      input,
      "https://preview.example",
      async () => new Response("stale"),
    ),
    /approved publication/,
  );
});

test("Netlify refuses a wrong site and competing Git builds before mutation", async () => {
  const profile = envelope().payload.publication;
  const site = {
    id: "site-1",
    ssl_url: profile.url,
    custom_domain: "writer.example",
    build_settings: { repo_url: "git@example/repo", stop_builds: false },
  };
  await assert.rejects(
    preflight("site-1", profile, "token", async () => Response.json(site)),
    /Stop Netlify Git builds/,
  );
  await assert.rejects(
    preflight("site-1", profile, "token", async () =>
      Response.json({
        ...site,
        custom_domain: "other.example",
        ssl_url: "https://other.example",
      }),
    ),
    /does not serve/,
  );
});

test("a delivery resumes its saved deploy and only promotes verified content", async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), "publication-state-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const profile = envelope().payload.publication;
  const calls: string[] = [];
  let current = false;
  const mockFetch: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    calls.push(`${options?.method ?? "GET"} ${path}`);
    if (path === "/api/v1/sites/site-1")
      return Response.json({ id: "site-1", ssl_url: profile.url });
    if (path.endsWith("/restore")) current = true;
    return Response.json({
      id: "deploy-1",
      site_id: "site-1",
      state: current ? "current" : "ready",
      required: [],
      deploy_ssl_url: "https://preview.example",
    });
  };
  const options = {
    siteId: "site-1",
    profile,
    files: new Map([["/index.html", Buffer.from("public")]]),
    stateDir,
    token: "token",
    fetcher: mockFetch,
  };
  await assert.rejects(
    deployFiles({
      ...options,
      verify: async () => {
        throw new Error("unverified");
      },
    }),
    /unverified/,
  );
  assert.equal(
    calls.some((call) => call.endsWith("/restore")),
    false,
  );
  const verified: string[] = [];
  assert.equal(
    await deployFiles({
      ...options,
      verify: async (url) => {
        verified.push(url);
      },
    }),
    "deploy-1",
  );
  assert.equal(
    calls.filter((call) => call === "POST /api/v1/sites/site-1/deploys").length,
    1,
  );
  assert.deepEqual(verified, ["https://preview.example", profile.url]);
});

test("the personal site preserves only already-published legacy writing", async () => {
  const built = await buildPublication(
    fileURLToPath(new URL("..", import.meta.url)),
    { id: "disusered", name: "Carlos", url: "https://disusered.com" },
    new Map(),
  );
  assert.equal(built.has("/blog/phoenix-with-typescript/index.html"), true);
  assert.equal(built.has("/blog/playing-with-phaser/index.html"), true);
  assert.equal(built.has("/blog/fastai/index.html"), false);
  for (const path of ["/blog/index.html", "/rss.xml", "/sitemap-0.xml"])
    assert.doesNotMatch(built.get(path)!.toString(), /\/blog\/fastai\//);
});

test("an isolated build renders a short illustrated post and full RSS without another identity's pages", async () => {
  const input = envelope({
    publication: {
      id: "other",
      name: "Another Voice",
      url: "https://other.example",
      did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb",
    },
    media: "link-post",
    externalUrl: "https://example.org/work",
    body: "A complete observation.\n\n![A red pixel](./assets/a-note/pixel.png)",
    assets: [
      {
        path: "assets/a-note/pixel.png",
        sha256: sha256(Buffer.from("89504e470d0a1a0a", "hex")),
        hex: "89504e470d0a1a0a",
      },
    ],
  });
  const files = snapshotFiles(
    {
      schemaVersion: "polychrome.publication-snapshot.v1",
      publication: "other",
      envelopes: [input],
    },
    input,
  );
  const built = await buildPublication(
    fileURLToPath(new URL("..", import.meta.url)),
    input.payload.publication,
    files,
  );
  assert.equal(built.has("/about/index.html"), false);
  assert.equal(built.has("/blog/fastai/index.html"), false);
  assert.equal(built.has("/assets/a-note/pixel.png"), true);
  for (const path of [
    "/index.html",
    "/blog/index.html",
    "/blog/a-note/index.html",
    "/rss.xml",
  ]) {
    const content = built.get(path)!.toString();
    assert.match(content, /A complete observation/);
    assert.doesNotMatch(
      content,
      /Carlos Antonio|crosquillas|github.com\/disusered|about-header/,
    );
  }
  assert.match(
    built.get("/rss.xml")!.toString(),
    /https:\/\/other.example\/assets\/a-note\/pixel.png/,
  );
  assert.match(
    built.get("/blog/a-note/index.html")!.toString(),
    /site.standard.document/,
  );
});
