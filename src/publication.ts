import { unified } from "@astrojs/markdown-remark";
import { toString } from "hast-util-to-string";
import { canonical, sha256 } from "./publication-hash.ts";
import { remarkEmbeds } from "./embeds.ts";
export { sha256 } from "./publication-hash.ts";

export type Destination = "website" | "atproto" | "bluesky";
export interface PublicationProfile {
  id: string;
  name: string;
  url: string;
  did: string;
}
export interface PublicPost {
  schemaVersion: "polychrome.public-post.v2";
  publication: PublicationProfile;
  media: "note" | "link-post" | "long-form";
  slug: string;
  title: string;
  description: string;
  pubDate: string;
  tags: string[];
  body: string;
  assets: { path: string; sha256: string; hex: string }[];
  externalUrl?: string;
  blueskyText?: string;
  feedPresentation?: "native" | "announcement";
  /** Names one of `assets` (`assets/<slug>/<name>`) shown as the post's cover. */
  cover?: { name: string; alt: string };
  destinations: Destination[];
}
export interface PublicationEnvelope {
  schemaVersion: "polychrome.publication-envelope.v2";
  channel: "publication";
  edition: { id: string; revision: string };
  preparedAt: string;
  payload: PublicPost;
  payloadSha256: string;
  envelopeSha256: string;
}
export interface PublicationSnapshot {
  schemaVersion: "polychrome.publication-snapshot.v1";
  publication: string;
  envelopes: PublicationEnvelope[];
}
export function publicUrl(value: string, allowHttp = false): URL {
  const url = new URL(value);
  if (
    !(url.protocol === "https:" || (allowHttp && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    /^(localhost|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i.test(
      url.hostname,
    )
  )
    throw new Error("A public HTTPS URL is required.");
  return url;
}

export function validateEnvelope(envelope: PublicationEnvelope): void {
  const { envelopeSha256, ...core } = envelope;
  const post = envelope.payload;
  if (
    envelope.schemaVersion !== "polychrome.publication-envelope.v2" ||
    envelope.channel !== "publication" ||
    post?.schemaVersion !== "polychrome.public-post.v2" ||
    sha256(canonical(core)) !== envelopeSha256 ||
    sha256(canonical(post)) !== envelope.payloadSha256 ||
    !/^red:[\w-]+$/.test(envelope.edition.id) ||
    !/^sha256:[a-f0-9]{64}$/.test(envelope.edition.revision) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(post.slug) ||
    !/^[a-zA-Z0-9_-]+$/.test(post.publication.id) ||
    !/^did:(plc|web):[a-zA-Z0-9._:%-]+$/.test(post.publication.did) ||
    Number.isNaN(Date.parse(envelope.preparedAt)) ||
    (post.feedPresentation !== undefined &&
      !["native", "announcement"].includes(post.feedPresentation)) ||
    (post.cover !== undefined &&
      (typeof post.cover.alt !== "string" ||
        !/^[a-zA-Z0-9_-]+\.(png|jpg|jpeg|gif|webp)$/.test(post.cover.name))) ||
    !post.destinations.length ||
    (post.destinations.includes("atproto") &&
      !post.destinations.includes("website")) ||
    post.destinations.some(
      (target) => !["website", "atproto", "bluesky"].includes(target),
    )
  )
    throw new Error("Invalid approved publication envelope.");
  const url = publicUrl(post.publication.url);
  if (url.origin !== post.publication.url)
    throw new Error(
      "The publication URL must be an HTTPS origin without a trailing slash.",
    );
  if (post.externalUrl) publicUrl(post.externalUrl, true);
  if (typeof post.body !== "string" || privateReference(post.body, true))
    throw new Error("Private references are not public content.");
  for (const value of [
    post.title,
    post.description,
    post.publication.name,
    post.blueskyText ?? "",
    post.cover?.alt ?? "",
    ...post.tags,
  ]) {
    if (typeof value !== "string" || privateReference(value))
      throw new Error("Private references are not public content.");
  }
}

/**
 * True when public text names a private location. In Markdown bodies a local
 * address is allowed inside fenced code blocks and inline code spans, where it
 * is an example; it is still refused in prose and link destinations. Plain
 * fields refuse it everywhere. Mirrors Red's `withoutCode` rule.
 */
export function privateReference(text: string, markdown = false): boolean {
  const prose = markdown
    ? text
        .replace(
          /^ {0,3}((`|~)\2{2,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1\2*[ \t]*$|(?![\s\S]))/gm,
          " ",
        )
        .replace(/(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g, " ")
    : text;
  return (
    /polychrome:\/\/|file:\/\/|\/home\//i.test(text) ||
    /localhost|127\.0\.0\.1/i.test(prose)
  );
}

function encodeTid(value: bigint): string {
  let key = "";
  const alphabet = "234567abcdefghijklmnopqrstuvwxyz";
  for (let index = 0; index < 13; index++) {
    key = alphabet[Number(value & 31n)] + key;
    value >>= 5n;
  }
  return key;
}
const stableTid = (value: string) =>
  encodeTid(BigInt(`0x${sha256(value).slice(0, 16)}`) & ((1n << 63n) - 1n));
export const publicationKey = (profile: PublicationProfile) =>
  stableTid(`publication:${profile.id}`);
export const documentKey = (envelope: PublicationEnvelope) =>
  stableTid(
    `document:${envelope.payload.publication.id}:${envelope.edition.id}`,
  );
export const documentUri = (envelope: PublicationEnvelope) =>
  `at://${envelope.payload.publication.did}/site.standard.document/${documentKey(envelope)}`;
export const canonicalUrl = (envelope: PublicationEnvelope) =>
  `${envelope.payload.publication.url}/blog/${envelope.payload.slug}/`;
export function blueskyKey(envelope: PublicationEnvelope): string {
  const digest = sha256(
    `bluesky:${envelope.payload.publication.id}:${envelope.edition.id}:${envelope.edition.revision}`,
  );
  const micros =
    BigInt(Date.parse(envelope.preparedAt)) * 1000n +
    BigInt(parseInt(digest.slice(0, 5), 16) % 1000);
  return encodeTid(
    (micros << 10n) | BigInt(parseInt(digest.slice(5, 8), 16) % 1024),
  );
}

/**
 * The same Markdown renderer supplies full RSS HTML and portable plain text.
 * Allowlisted bare URLs become iframes in the HTML and stay URLs in the text.
 */
export async function renderWriting(body: string, site: string) {
  let text = "";
  const renderer = await unified({
    smartypants: false,
    remarkPlugins: [remarkEmbeds({ site })],
    rehypePlugins: [
      () => (tree) => {
        text = tree.children
          .map((node) => toString(node))
          .join("\n")
          .trim();
      },
    ],
  }).createRenderer({ syntaxHighlight: false });
  const { code } = await renderer.render(body);
  return { html: code, text };
}
