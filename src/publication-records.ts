import { main as publicationSchema } from "./lexicons/site/standard/publication.defs.ts";
import { main as documentSchema } from "./lexicons/site/standard/document.defs.ts";
import { main as postSchema } from "./lexicons/app/bsky/feed/post.defs.ts";
import {
  blueskyKey,
  canonicalUrl,
  documentKey,
  publicationKey,
  renderWriting,
  validateEnvelope,
  type PublicationEnvelope,
} from "./publication.ts";

/** Builders are deterministic; the authenticated Portal worker owns network writes. */
export async function buildRecords(envelope: PublicationEnvelope) {
  validateEnvelope(envelope);
  const post = envelope.payload;
  const profile = post.publication;
  const publicationRkey = publicationKey(profile);
  const publicationRecord = {
    $type: "site.standard.publication",
    name: profile.name,
    url: profile.url,
  };
  const rendered = await renderWriting(post.body);
  const documentRecord = {
    $type: "site.standard.document",
    site: `at://${profile.did}/site.standard.publication/${publicationRkey}`,
    path: `/blog/${post.slug}/`,
    title: post.title,
    description: post.description,
    publishedAt: `${post.pubDate}T00:00:00.000Z`,
    textContent: [rendered.text, post.externalUrl].filter(Boolean).join("\n\n"),
    tags: post.tags,
  };
  const publication = {
    collection: "site.standard.publication",
    rkey: publicationRkey,
    record: publicationSchema.parse(publicationRecord),
  };
  const document = {
    collection: "site.standard.document",
    rkey: documentKey(envelope),
    record: documentSchema.parse(documentRecord),
  };
  if (!post.destinations.includes("bluesky")) return { publication, document };
  if (typeof post.blueskyText !== "string")
    throw new Error("Review Bluesky text before publishing.");
  const text = post.blueskyText;
  const facets = [...text.matchAll(/https?:\/\/[^\s<>]+/g)].map((match) => {
    const uri = match[0].replace(/[.,!?;:)]+$/, "");
    return {
      index: {
        byteStart: Buffer.byteLength(text.slice(0, match.index)),
        byteEnd: Buffer.byteLength(text.slice(0, match.index) + uri),
      },
      features: [{ $type: "app.bsky.richtext.facet#link", uri }],
    };
  });
  const record = postSchema.parse({
    $type: "app.bsky.feed.post",
    text,
    createdAt: envelope.preparedAt,
    ...(facets.length ? { facets } : {}),
    embed: {
      $type: "app.bsky.embed.external",
      external: {
        uri: post.externalUrl || canonicalUrl(envelope),
        title: post.title,
        description: post.description,
      },
    },
  });
  return {
    publication,
    document,
    bluesky: {
      collection: "app.bsky.feed.post",
      rkey: blueskyKey(envelope),
      record,
    },
  };
}
