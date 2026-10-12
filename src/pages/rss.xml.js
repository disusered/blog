import rss from "@astrojs/rss";
import { getCollection, render } from "astro:content";
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import mdxRenderer from "@astrojs/mdx/server.js";
import { SITE_TITLE, SITE_DESCRIPTION } from "../consts";

export async function GET(context) {
  const posts = (await getCollection("blog")).sort(
    (a, b) => b.data.pubDate - a.data.pubDate,
  );
  const container = await AstroContainer.create();
  container.addServerRenderer({ name: "@astrojs/mdx", renderer: mdxRenderer });
  const items = await Promise.all(
    posts.map(async (post) => {
      const { Content } = await render(post);
      const body = await container.renderToString(Content);
      const content = body.replace(
        /(href|src)="([^"#]+)"/g,
        (_, attribute, value) =>
          `${attribute}="${new URL(value, new URL(`/blog/${post.id}/`, context.site)).href}"`,
      );
      const link = post.data.externalUrl
        ? `<p><a href="${post.data.externalUrl.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">Original link</a></p>`
        : "";
      return {
        ...post.data,
        content: link + content,
        link: `/blog/${post.id}/`,
        customData: post.data.publicationHash
          ? `<polychrome:hash>${post.data.publicationHash}</polychrome:hash>`
          : undefined,
      };
    }),
  );
  return rss({
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    site: context.site,
    xmlns: { polychrome: "https://disusered.com/ns/polychrome" },
    items,
  });
}
