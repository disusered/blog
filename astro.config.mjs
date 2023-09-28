import { defineConfig } from "astro/config";
import mdx from "@astrojs/mdx";
import sitemap from "@astrojs/sitemap";
import { SITE_URL } from "./src/consts";
import robotsTxt from "astro-robots-txt";

// https://astro.build/config
export default defineConfig({
  site: SITE_URL,
  integrations: [mdx(), sitemap(), robotsTxt()],
  markdown: {
    shikiConfig: {
      theme: "rose-pine-moon",
    },
  },
});
