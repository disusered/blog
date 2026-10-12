import { getCollection } from "astro:content";

/** Published posts only; a draft stays in the repository without a page or feed entry. */
export const getPosts = () =>
  getCollection("blog", ({ data }) => data.draft !== true);
