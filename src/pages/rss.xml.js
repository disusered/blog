import rss from "@astrojs/rss";
import { getCollection } from "astro:content";
import { SITE_TITLE, SITE_DESCRIPTION } from "../consts";

export async function GET(context) {
  const posts = await getCollection("blog");
  return rss({
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
    site: context.site,
    xmlns: { polychrome: "https://disusered.com/ns/polychrome" },
    items: posts.map((post) => ({
      ...post.data,
      link: `/blog/${post.id}/`,
      customData: post.data.publicationHash
        ? `<polychrome:hash>${post.data.publicationHash}</polychrome:hash>`
        : undefined,
    })),
  });
}
