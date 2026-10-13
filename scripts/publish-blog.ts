import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonical } from "../src/publication-hash.ts";
import {
  documentUri,
  privateReference,
  validateEnvelope,
  type PublicationEnvelope,
  type PublicPost,
} from "../src/publication.ts";
export { canonical } from "../src/publication-hash.ts";

type Asset = { path: string; sha256: string; hex: string };
type Post = {
  schemaVersion: string;
  slug: string;
  title: string;
  description: string;
  pubDate: string;
  tags: string[];
  body: string;
  assets: Asset[];
};
export type Envelope = {
  schemaVersion: string;
  channel: string;
  edition: { id: string; revision: string };
  preparedAt: string;
  payload: Post;
  payloadSha256: string;
  envelopeSha256: string;
};
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

export function publicFiles(
  envelope: Envelope | PublicationEnvelope,
): Map<string, Buffer> {
  if (envelope.schemaVersion === "polychrome.publication-envelope.v2") {
    const approved = envelope as PublicationEnvelope;
    validateEnvelope(approved);
    if (!approved.payload.destinations.includes("website"))
      throw new Error("Website delivery was not selected.");
    return renderPost(
      approved.payload,
      approved.payloadSha256,
      documentUri(approved),
    );
  }
  const { envelopeSha256, ...core } = envelope;
  const post = envelope.payload;
  if (
    envelope.schemaVersion !== "polychrome.publication-envelope.v1" ||
    envelope.channel !== "blog" ||
    post.schemaVersion !== "polychrome.public-post.v1" ||
    hash(canonical(core)) !== envelopeSha256 ||
    hash(canonical(post)) !== envelope.payloadSha256
  )
    throw new Error("Invalid publication envelope.");
  return renderPost(post, envelope.payloadSha256);
}

export function previewFiles(preview: {
  schema: string;
  payload: Post;
  payloadSha256: string;
}): Map<string, Buffer> {
  if (
    preview.schema !== "polychrome.red-publication-preview.v1" ||
    hash(canonical(preview.payload)) !== preview.payloadSha256
  )
    throw new Error("Invalid publication preview.");
  return renderPost(preview.payload, preview.payloadSha256);
}

function renderPost(
  post: Post | PublicPost,
  payloadSha256: string,
  atUri?: string,
): Map<string, Buffer> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(post.slug))
    throw new Error("Invalid blog slug.");
  for (const text of [post.title, post.description, post.body, ...post.tags]) {
    if (typeof text !== "string" || privateReference(text, text === post.body))
      throw new Error("Private references are not public content.");
  }
  const files = new Map<string, Buffer>();
  const cover = "cover" in post ? post.cover : undefined;
  if (
    cover &&
    (typeof cover.alt !== "string" ||
      !post.assets.some(
        (asset) => asset.path === `assets/${post.slug}/${cover.name}`,
      ))
  )
    throw new Error("The cover must name one of the post's images.");
  const header = {
    title: post.title,
    description: post.description,
    pubDate: post.pubDate,
    tags: post.tags,
    publicationHash: payloadSha256,
    ...(post.schemaVersion === "polychrome.public-post.v2" &&
    "publication" in post
      ? {
          media: post.media,
          author: post.publication.name,
          externalUrl: post.externalUrl ?? null,
          standardDocument:
            post.feedPresentation !== undefined ||
            post.destinations.includes("atproto")
              ? atUri
              : null,
          ...(cover
            ? {
                heroImage: `/assets/${post.slug}/${cover.name}`,
                heroImageAlt: cover.alt,
              }
            : {}),
        }
      : {}),
  };
  files.set(
    `src/content/blog/${post.slug}.md`,
    Buffer.from(
      `---\n${Object.entries(header)
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
        .join(
          "\n",
        )}\n---\n${post.schemaVersion === "polychrome.public-post.v2" ? post.body.replaceAll(`./assets/${post.slug}/`, `/assets/${post.slug}/`) : post.body}`,
    ),
  );
  for (const asset of post.assets) {
    const prefix = `assets/${post.slug}/`;
    if (
      !asset.path.startsWith(prefix) ||
      !/^[a-zA-Z0-9_-]+\.(png|jpg|jpeg|gif|webp)$/.test(
        asset.path.slice(prefix.length),
      ) ||
      !/^(?:[a-f0-9]{2})+$/.test(asset.hex)
    )
      throw new Error("Invalid public asset.");
    const bytes = Buffer.from(asset.hex, "hex");
    const target =
      post.schemaVersion === "polychrome.public-post.v2"
        ? `public/${asset.path}`
        : `src/content/blog/${asset.path}`;
    if (hash(bytes) !== asset.sha256 || files.has(target))
      throw new Error("Asset checksum or filename conflict.");
    files.set(target, bytes);
  }
  return files;
}

export async function stage(envelope: Envelope, root: string, apply = false) {
  const files = publicFiles(envelope);
  const missing: [string, Buffer][] = [];
  for (const [path, bytes] of files) {
    const target = join(root, path);
    // Refuse symlinks in existing ancestors as well as the target.
    let current = resolve(root);
    for (const part of path.split("/")) {
      current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new Error("Publication paths cannot contain symlinks.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    try {
      if (!(await readFile(target)).equals(bytes))
        throw new Error(`Public file already differs: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push([target, bytes]);
    }
  }
  if (apply)
    for (const [target, bytes] of missing) {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes, { flag: "wx" });
    }
  return {
    outcome: apply ? (missing.length ? "staged" : "unchanged") : "preview",
    files: [...files].map(([path, bytes]) => ({ path, sha256: hash(bytes) })),
  };
}

export async function verifyDeployment(envelope: Envelope, commit: string) {
  publicFiles(envelope);
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new Error("An exact deployment commit is required.");
  const uri = `https://disusered.com/blog/${envelope.payload.slug}/`;
  const [page, rss] = await Promise.all([
    fetch(uri, { redirect: "error" }),
    fetch("https://disusered.com/rss.xml", { redirect: "error" }),
  ]);
  if (!page.ok || !rss.ok) throw new Error("The page or RSS is unavailable.");
  const marker = envelope.payloadSha256;
  const html = await page.text();
  const xml = await rss.text();
  const item = xml
    .match(/<item>[\s\S]*?<\/item>/g)
    ?.find((entry) => entry.includes(`<link>${uri}</link>`));
  if (
    !new RegExp(
      `<meta(?=[^>]*name=["']polychrome-publication["'])(?=[^>]*content=["']${marker}["'])[^>]*>`,
    ).test(html) ||
    !item?.includes(`<polychrome:hash>${marker}</polychrome:hash>`)
  )
    throw new Error(
      "The deployed page and RSS do not contain this exact publication.",
    );
  return {
    schemaVersion: "polychrome.blog.receipt.v1",
    editionId: envelope.edition.id,
    editionRevision: envelope.edition.revision,
    envelopeSha256: envelope.envelopeSha256,
    payloadSha256: marker,
    uri,
    commit,
    publishedAt: new Date().toISOString(),
    pageVerified: true,
    rssVerified: true,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  const path = args[0];
  if (!path || path.startsWith("-"))
    throw new Error(
      "Usage: node scripts/publish-blog.ts ENVELOPE [--apply | --verify COMMIT]",
    );
  const envelope = JSON.parse(await readFile(path, "utf8")) as Envelope;
  console.log(
    JSON.stringify(
      args[1] === "--verify"
        ? await verifyDeployment(envelope, args[2])
        : await stage(envelope, process.cwd(), args[1] === "--apply"),
      null,
      2,
    ),
  );
}
