import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import { SITE_URL } from "./src/consts";
import robotsTxt from "astro-robots-txt";
import remarkToc from "remark-toc";

// https://astro.build/config
export default defineConfig({
  site: SITE_URL,
  integrations: [mdx(), sitemap(), robotsTxt()],
  markdown: {
    remarkPlugins: [remarkToc],
    shikiConfig: {
      theme: "rose-pine-moon",
    },
  },
});
