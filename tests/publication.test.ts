import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { canonical, sha256 } from "../src/publication-hash.ts";
import { buildRecords } from "../src/publication-records.ts";
import { operate } from "../scripts/publication-worker.ts";
import { publicFiles } from "../scripts/publish-blog.ts";
import { metadataFiles, snapshotFiles } from "../src/publication-build.ts";
import {
  preflight,
  verifyPublication,
  waitForPublication,
} from "../src/netlify-publication.ts";
import { publisherGit, repositoryFor } from "../src/git-publication.ts";
import {
  canonicalUrl,
  validateEnvelope,
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
    feedPresentation: "native",
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
  assert.match(first.document!.record.textContent!, /something interesting/);
  assert.match(first.document!.record.textContent!, /Another paragraph/);
  assert.doesNotMatch(first.document!.record.textContent!, /\*\*/);
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
  assert.equal(corrected.document!.rkey, first.document!.rkey);
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
  assert.notEqual(secondIdentity.document!.rkey, first.document!.rkey);
});

test("native microposts omit website records and generated link cards", async () => {
  for (const media of ["note", "link-post"] as const) {
    const native = await buildRecords(
      envelope({ media, destinations: ["bluesky"] }),
    );
    assert.equal(native.publication, undefined);
    assert.equal(native.document, undefined);
    assert.equal(native.bluesky!.record.embed, undefined);
    assert.equal(native.bluesky!.record.text, envelope().payload.blueskyText);
  }
  const websiteNote = await buildRecords(
    envelope({ destinations: ["website", "bluesky"] }),
  );
  assert.ok(websiteNote.document);
  assert.equal(websiteNote.bluesky!.record.embed, undefined);
  const linked = await buildRecords(
    envelope({
      destinations: ["bluesky"],
      externalUrl: "https://example.org/shared",
    }),
  );
  assert.deepEqual(linked.bluesky!.record.embed, {
    $type: "app.bsky.embed.external",
    external: {
      uri: "https://example.org/shared",
      title: "A note",
      description: "My observation",
    },
  });
  const article = await buildRecords(
    envelope({
      media: "long-form",
      feedPresentation: "announcement",
      destinations: ["website", "bluesky"],
    }),
  );
  assert.deepEqual(article.bluesky!.record.embed, {
    $type: "app.bsky.embed.external",
    external: {
      uri: canonicalUrl(envelope()),
      title: "A note",
      description: "My observation",
    },
  });
  const socialArticle = await buildRecords(
    envelope({ media: "long-form", destinations: ["bluesky"] }),
  );
  assert.equal(socialArticle.bluesky!.record.embed, undefined);
});

test("legacy envelopes retain their approved website link card", async () => {
  const input = envelope({ feedPresentation: undefined });
  const records = await buildRecords(input);
  assert.deepEqual(records.bluesky!.record.embed, {
    $type: "app.bsky.embed.external",
    external: {
      uri: canonicalUrl(input),
      title: input.payload.title,
      description: input.payload.description,
    },
  });
});

test("website exports require selection and Standard metadata follows website publishing", async () => {
  const input = envelope({ destinations: ["bluesky"] });
  assert.throws(() => publicFiles(input), /Website delivery was not selected/);
  await assert.rejects(
    operate({
      action: "website",
      envelope: input,
      snapshot: {
        schemaVersion: "polychrome.publication-snapshot.v1",
        publication: "carlos",
        envelopes: [input],
      },
      siteId: "site-1",
    }),
    /Website delivery was not selected/,
  );
  const website = envelope({ destinations: ["website"] });
  const files = snapshotFiles(
    {
      schemaVersion: "polychrome.publication-snapshot.v1",
      publication: "carlos",
      envelopes: [website],
    },
    website,
  );
  assert.ok(files.has("public/.well-known/site.standard.publication"));
  assert.match(
    files.get("src/content/blog/a-note.md")!.toString(),
    /standardDocument: "at:\/\//,
  );
});

test("native image proposals preserve frozen bytes and the author's alt text", async () => {
  const bytes = Buffer.from("image fixture");
  const asset = {
    path: "assets/a-note/cat.png",
    sha256: sha256(bytes),
    hex: bytes.toString("hex"),
  };
  const input = envelope({
    destinations: ["bluesky"],
    body: "![A curious cat](./assets/a-note/cat.png)",
    assets: [asset],
  });
  const native = await buildRecords(input);
  assert.deepEqual(native.bluesky!.reviewedImages, [
    { ...asset, alt: "A curious cat" },
  ]);
  assert.equal(native.bluesky!.record.embed, undefined);
  await assert.rejects(
    buildRecords(
      envelope({ ...input.payload, externalUrl: "https://example.org/shared" }),
    ),
    /images or a link card/,
  );
  await assert.rejects(
    buildRecords(envelope({ ...input.payload, assets: [] })),
    /frozen publication asset/,
  );
  await assert.rejects(
    buildRecords(
      envelope({
        ...input.payload,
        body: Array(5).fill(input.payload.body).join("\n"),
      }),
    ),
    /at most four/,
  );
});

test("local addresses are allowed in code and refused in prose and links", () => {
  for (const body of [
    "Run `http://localhost:4000` locally.",
    "x ``a ` localhost`` y",
    "````\nlocalhost\n```\nstill code\n`````",
    "```sh\ncurl http://127.0.0.1:4000\n```",
    "~~~\nlocalhost\n~~~\n\nDone.",
  ]) {
    validateEnvelope(envelope({ body }));
    assert.ok(publicFiles(envelope({ body })).size);
  }
  for (const body of [
    "Visit localhost to see it.",
    "[`localhost:4000`](http://localhost:4000)",
    "<http://127.0.0.1:4000>",
    "```\ncode\n```\n\nthen localhost",
    "`file:///etc/passwd`",
    "`/home/carlos/notes`",
    "```\nlocalhost\n~~~\nstill code\n``\nstill code\n```\nlocalhost",
    "a `b` localhost `c`",
  ])
    assert.throws(
      () => validateEnvelope(envelope({ body })),
      /Private references/,
      body,
    );
  // Plain fields are not Markdown, so code formatting does not excuse them.
  assert.throws(
    () => validateEnvelope(envelope({ title: "`localhost`" })),
    /Private references/,
  );
});

test("a cover names a frozen image for the hero and the document's cover blob", async () => {
  const bytes = Buffer.from("cover fixture");
  const asset = {
    path: "assets/a-note/cover.png",
    sha256: sha256(bytes),
    hex: bytes.toString("hex"),
  };
  const input = envelope({
    media: "long-form",
    destinations: ["website", "atproto"],
    blueskyText: undefined,
    assets: [asset],
    cover: { name: "cover.png", alt: "A cat on a keyboard" },
  });
  const markdown = publicFiles(input)
    .get("src/content/blog/a-note.md")!
    .toString();
  assert.match(markdown, /^heroImage: "\/assets\/a-note\/cover\.png"$/m);
  assert.match(markdown, /^heroImageAlt: "A cat on a keyboard"$/m);
  const records = await buildRecords(input);
  assert.deepEqual(records.document!.reviewedCover, {
    ...asset,
    alt: "A cat on a keyboard",
  });
  assert.equal(records.document!.record.coverImage, undefined);
  for (const cover of [
    { name: "../cover.png", alt: "x" },
    { name: "cover.png" } as { name: string; alt: string },
  ])
    assert.throws(
      () => validateEnvelope(envelope({ ...input.payload, cover })),
      /Invalid approved/,
    );
  const missing = envelope({ ...input.payload, assets: [] });
  assert.throws(() => publicFiles(missing), /cover must name/);
  await assert.rejects(buildRecords(missing), /cover must name/);
  const plain = envelope({ destinations: ["website", "atproto"] });
  assert.doesNotMatch(
    publicFiles(plain).get("src/content/blog/a-note.md")!.toString(),
    /heroImage/,
  );
  assert.equal((await buildRecords(plain)).document!.reviewedCover, undefined);
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

test("delivery commits signed public files, replaces a same-slug hand-written post, and repeats without a new commit", async (t) => {
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
  const blog = join(seed, "src/content/blog");
  await writeFile(join(blog, "legacy.md"), "---\ntitle: x\n---\n");
  await writeFile(
    join(blog, "a-note.mdx"),
    '---\nheroImage: "./hero.png"\n---\nimport shot from "./shot.png";\n\n![Shared](./shared.png)\n![Parent](../outside.png)\n',
  );
  await writeFile(join(blog, "other.md"), "![Shared](./shared.png)\n");
  for (const name of ["hero.png", "shot.png", "shared.png", "unrelated.png"])
    await writeFile(join(blog, name), name);
  await writeFile(join(seed, "src/content/outside.png"), "outside");
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
  const replaced = await git.write(files);
  assert.deepEqual(replaced, [
    "src/content/blog/a-note.mdx",
    "src/content/blog/hero.png",
    "src/content/blog/shot.png",
  ]);
  const commit = await git.commit(
    [...files.keys(), ...replaced],
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
  const { stdout: tree } = await exec(
    "git",
    ["--git-dir", remote, "ls-tree", "-r", "--name-only", commit!],
    plain,
  );
  assert.deepEqual(tree.trim().split("\n").sort(), [
    "public/.well-known/site.standard.publication",
    "src/content/blog/a-note.md",
    "src/content/blog/legacy.md",
    "src/content/blog/other.md",
    "src/content/blog/shared.png",
    "src/content/blog/unrelated.png",
    "src/content/outside.png",
  ]);
  assert.match(
    await readFile(
      join(root, "state/clone/src/content/blog/a-note.md"),
      "utf8",
    ),
    /publicationHash/,
  );

  const head = await git.sync(repository);
  assert.equal(head, commit);
  assert.deepEqual(await git.write(files), []);
  assert.equal(await git.commit([...files.keys()], "again"), undefined);

  assert.deepEqual(
    await git.write(
      new Map([["src/content/blog/legacy.md", Buffer.from("x")]]),
    ),
    ["src/content/blog/legacy.md"],
  );
  await git.sync(repository);
  await writeFile(join(root, "state/clone/src/content/blog/x.png"), "x");
  await assert.rejects(
    git.write(new Map([["src/content/blog/x.png", Buffer.from("y")]])),
    /The permalink collides with existing writing: src\/content\/blog\/x\.png/,
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
