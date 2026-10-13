import { EMBED_HOSTS } from "./consts.ts";

type Node = {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
  data?: Record<string, unknown>;
};
export type EmbedOptions = { site: string; hosts?: typeof EMBED_HOSTS };

/** The frame URL and sandbox for an allowlisted page URL, or nothing. */
export function embedFor(
  value: string,
  { site, hosts = EMBED_HOSTS }: EmbedOptions,
): { src: string; sandbox: string } | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password)
    return undefined;
  // Own demos need their origin to load assets; alert() needs allow-modals.
  if (url.origin === new URL(site).origin)
    return {
      src: url.href,
      sandbox: "allow-scripts allow-same-origin allow-modals",
    };
  const entry = hosts.find(({ hosts }) => hosts.includes(url.hostname));
  if (!entry) return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  if (entry.embed === "youtube") {
    const id =
      url.hostname === "youtu.be"
        ? parts[0]
        : parts[0] === "watch"
          ? url.searchParams.get("v")
          : ["embed", "shorts"].includes(parts[0] ?? "")
            ? parts[1]
            : undefined;
    return id && /^[\w-]{11}$/.test(id)
      ? {
          src: `https://www.youtube-nocookie.com/embed/${id}`,
          sandbox: entry.sandbox,
        }
      : undefined;
  }
  const [user, kind, id] = parts;
  return user &&
    id &&
    ["pen", "embed", "full"].includes(kind ?? "") &&
    /^[\w-]+$/.test(user + id)
    ? {
        src: `https://codepen.io/${user}/embed/${id}?default-tab=result`,
        sandbox: entry.sandbox,
      }
    : undefined;
}

/**
 * A paragraph holding only a bare URL (an autolink, or a link whose text is its
 * href) on an allowlisted host becomes a sandboxed iframe with a fallback link.
 * The link stays a real text node, so plain-text renderings keep the URL.
 */
export function remarkEmbeds(options: EmbedOptions) {
  const visit = (node: Node) => {
    for (const child of node.children ?? []) visit(child);
    if (node.type !== "paragraph") return;
    const content = (node.children ?? []).filter(
      (child) => !(child.type === "text" && !child.value?.trim()),
    );
    const link = content[0];
    const text = link?.children?.[0];
    if (
      content.length !== 1 ||
      link.type !== "link" ||
      link.children?.length !== 1 ||
      text?.type !== "text" ||
      text.value !== link.url
    )
      return;
    const embed = embedFor(link.url!, options);
    if (!embed) return;
    node.data = {
      hName: "figure",
      hProperties: { className: ["embed"] },
      hChildren: [
        {
          type: "element",
          tagName: "iframe",
          properties: {
            src: embed.src,
            title: link.url,
            sandbox: embed.sandbox.split(" "),
            loading: "lazy",
            referrerPolicy: "strict-origin-when-cross-origin",
            allowFullScreen: true,
            style: "width:100%;aspect-ratio:16/9;border:0",
          },
          children: [],
        },
        {
          type: "element",
          tagName: "figcaption",
          properties: {},
          children: [
            {
              type: "element",
              tagName: "a",
              properties: { href: link.url },
              children: [{ type: "text", value: link.url }],
            },
          ],
        },
      ],
    };
  };
  return () => (tree: unknown) => visit(tree as Node);
}
