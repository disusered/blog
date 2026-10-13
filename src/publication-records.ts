import {
  main as publicationSchema,
  type Main as PublicationRecord,
} from "./lexicons/site/standard/publication.defs.ts";
import {
  main as documentSchema,
  type Main as DocumentRecord,
} from "./lexicons/site/standard/document.defs.ts";
import {
  main as postSchema,
  type Main as BlueskyRecord,
} from "./lexicons/app/bsky/feed/post.defs.ts";
import {
  blueskyKey,
  canonicalUrl,
  documentKey,
  publicationKey,
  renderWriting,
  validateEnvelope,
  type PublicationEnvelope,
} from "./publication.ts";

interface RecordProposal<T> {
  collection: string;
  rkey: string;
  record: T;
}
type ReviewedImage = {
  path: string;
  sha256: string;
  hex: string;
  alt: string;
};
interface PublicationRecords {
  publication?: RecordProposal<PublicationRecord>;
  /** The worker uploads `reviewedCover` and sets it as `coverImage`. */
  document?: RecordProposal<DocumentRecord> & { reviewedCover?: ReviewedImage };
  bluesky?: RecordProposal<BlueskyRecord> & {
    reviewedImages?: ReviewedImage[];
  };
}

/** Builders are deterministic; the authenticated Portal worker owns network writes. */
export async function buildRecords(
  envelope: PublicationEnvelope,
): Promise<PublicationRecords> {
  validateEnvelope(envelope);
  const post = envelope.payload;
  const profile = post.publication;
  const website = post.destinations.includes("website");
  const documents: Pick<PublicationRecords, "publication" | "document"> =
    website
      ? await (async () => {
          const publicationRkey = publicationKey(profile);
          const publicationRecord = {
            $type: "site.standard.publication",
            name: profile.name,
            url: profile.url,
          };
          const rendered = await renderWriting(post.body, profile.url);
          const documentRecord = {
            $type: "site.standard.document",
            site: `at://${profile.did}/site.standard.publication/${publicationRkey}`,
            path: `/blog/${post.slug}/`,
            title: post.title,
            description: post.description,
            publishedAt: `${post.pubDate}T00:00:00.000Z`,
            textContent: [rendered.text, post.externalUrl]
              .filter(Boolean)
              .join("\n\n"),
            tags: post.tags,
          };
          const publication = {
            collection: "site.standard.publication",
            rkey: publicationRkey,
            record: publicationSchema.parse(publicationRecord),
          };
          const cover = post.cover && {
            ...post.assets.find(
              (asset) =>
                asset.path === `assets/${post.slug}/${post.cover!.name}`,
            )!,
            alt: post.cover.alt,
          };
          if (cover && !cover.hex)
            throw new Error("The cover must name one of the post's images.");
          // site.standard.document limits coverImage to 1,000,000 bytes.
          if (cover && cover.hex.length / 2 > 1_000_000)
            throw new Error(
              "The cover image must be under 1 MB for AT Protocol.",
            );
          const document = {
            collection: "site.standard.document",
            rkey: documentKey(envelope),
            record: documentSchema.parse(documentRecord),
            ...(cover ? { reviewedCover: cover } : {}),
          };
          return { publication, document };
        })()
      : {};
  if (!post.destinations.includes("bluesky")) return documents;
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
  const reviewedImages =
    post.feedPresentation !== "native"
      ? []
      : [
          ...post.body.matchAll(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g),
        ].map((match) => {
          const path = match[2].replace(/^\.\//, "").replace(/^\//, "");
          const asset = post.assets.find((asset) => asset.path === path);
          if (!asset)
            throw new Error(
              "A Bluesky image must be a frozen publication asset.",
            );
          return { ...asset, alt: match[1] };
        });
  if (reviewedImages.length > 4)
    throw new Error("Bluesky supports at most four images per post.");
  const externalUri =
    post.externalUrl ||
    (post.feedPresentation !== "native" && website
      ? canonicalUrl(envelope)
      : undefined);
  if (externalUri && reviewedImages.length)
    throw new Error("Choose images or a link card for this Bluesky post.");
  const record = postSchema.parse({
    $type: "app.bsky.feed.post",
    text,
    createdAt: envelope.preparedAt,
    ...(facets.length ? { facets } : {}),
    ...(externalUri
      ? {
          embed: {
            $type: "app.bsky.embed.external",
            external: {
              uri: externalUri,
              title: post.title,
              description: post.description,
            },
          },
        }
      : {}),
  });
  return {
    ...documents,
    bluesky: {
      collection: "app.bsky.feed.post",
      rkey: blueskyKey(envelope),
      record,
      ...(reviewedImages.length ? { reviewedImages } : {}),
    },
  };
}
