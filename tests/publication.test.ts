import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { canonical, sha256 } from "../src/publication-hash.ts";
import { buildRecords } from "../src/publication-records.ts";
import { metadataFiles, snapshotFiles } from "../src/publication-build.ts";
import {
  preflight,
  verifyPublication,
  waitForPublication,
} from "../src/netlify-publication.ts";
import { publisherGit, repositoryFor } from "../src/git-publication.ts";
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

test("Netlify requires the site's Git builds and names the repository to push", async () => {
  const profile = envelope().payload.publication;
  const site = {
    id: "site-1",
    ssl_url: profile.url,
    custom_domain: "writer.example",
    build_settings: {
      repo_url: "https://github.com/writer/blog",
      repo_branch: "main",
      stop_builds: false,
    },
  };
  assert.deepEqual(
    (
      await preflight("site-1", profile, "token", async () =>
        Response.json(site),
      )
    ).repository,
    { url: "git@github.com:writer/blog.git", branch: "main" },
  );
  await assert.rejects(
    preflight("site-1", profile, "token", async () =>
      Response.json({
        ...site,
        build_settings: { ...site.build_settings, stop_builds: true },
      }),
    ),
    /enable builds/,
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
  assert.throws(() => repositoryFor("https://gitlab.com/x/y"), /GitHub/);
});

test("delivery commits signed public files, keeps hand-written posts, and repeats without a new commit", async (t) => {
  const exec = promisify(execFile);
  const root = await mkdtemp(join(tmpdir(), "publication-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = join(root, "key");
  await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const plain = { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } };
  await exec("git", ["init", "-q", "--bare", "-b", "main", remote], plain);
  await exec("git", ["clone", "-q", remote, seed], plain);
  await mkdir(join(seed, "src/content/blog"), { recursive: true });
  await writeFile(
    join(seed, "src/content/blog/legacy.md"),
    "---\ntitle: x\n---\n",
  );
  for (const args of [
    ["add", "."],
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed"],
    ["push", "-q", "origin", "HEAD:main"],
  ])
    await exec("git", args, { ...plain, cwd: seed });

  const repository = { url: remote, branch: "main" };
  const git = publisherGit({ clone: join(root, "state/clone"), key });
  const input = envelope();
  const files = snapshotFiles(
    {
      schemaVersion: "polychrome.publication-snapshot.v1",
      publication: "carlos",
      envelopes: [input],
    },
    input,
  );
  await git.sync(repository);
  await git.write(files);
  const commit = await git.commit(
    [...files.keys()],
    "feat(content): publish a-note",
  );
  assert.match(commit!, /^[a-f0-9]{40}$/);
  assert.equal(await git.push(repository), true);
  assert.equal(await git.published(commit!, repository), true);
  const { stdout } = await exec(
    "git",
    ["--git-dir", remote, "cat-file", "commit", commit!],
    plain,
  );
  assert.match(stdout, /BEGIN SSH SIGNATURE/);
  assert.match(
    await readFile(
      join(root, "state/clone/src/content/blog/a-note.md"),
      "utf8",
    ),
    /publicationHash/,
  );

  const head = await git.sync(repository);
  assert.equal(head, commit);
  await git.write(files);
  assert.equal(await git.commit([...files.keys()], "again"), undefined);

  await assert.rejects(
    git.write(new Map([["src/content/blog/legacy.md", Buffer.from("x")]])),
    /collides with existing writing/,
  );
  await assert.rejects(
    git.write(new Map([["../escape.md", Buffer.from("x")]])),
    /inside the repository/,
  );
});

test("waiting fails on a broken Netlify build and returns the commit's deploy once live", async () => {
  const site = { id: "site-1", published_deploy: { id: "deploy-live" } };
  const respond =
    (state: string): typeof fetch =>
    async (url) =>
      String(url).includes("/deploys")
        ? Response.json([
            { id: "deploy-1", commit_ref: "abc", context: "production", state },
          ])
        : Response.json(site);
  await assert.rejects(
    waitForPublication({
      siteId: "site-1",
      commit: "abc",
      token: "token",
      verify: async () => {
        throw new Error("not yet");
      },
      fetcher: respond("error"),
      interval: 0,
    }),
    /could not build/,
  );
  let checks = 0;
  assert.equal(
    await waitForPublication({
      siteId: "site-1",
      commit: "abc",
      token: "token",
      verify: async () => {
        if (++checks < 3) throw new Error("not yet");
      },
      fetcher: respond("building"),
      interval: 0,
    }),
    "deploy-1",
  );
  await assert.rejects(
    waitForPublication({
      siteId: "site-1",
      commit: "abc",
      token: "token",
      verify: async () => {
        throw new Error("never live");
      },
      fetcher: respond("building"),
      attempts: 2,
      interval: 0,
    }),
    /never live/,
  );
});
