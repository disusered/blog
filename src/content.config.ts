import { defineCollection, type ImageFunction } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const imageWithAlt = (image: ImageFunction) =>
  z.object({
    heroImage: image(),
    heroImageAlt: z.string(),
  });

const noImage = z.object({
  heroImage: z.undefined(),
  heroImageAlt: z.undefined(),
});

const blog = defineCollection({
  loader: glob({ base: "./src/content/blog", pattern: "**/*.{md,mdx}" }),
  schema: ({ image }) =>
    z
      .object({
        title: z.string(),
        description: z.string(),
        pubDate: z.coerce.date(),
        updatedDate: z.coerce.date().optional(),
        tags: z.array(z.string()).optional(),
      })
      .and(imageWithAlt(image).or(noImage)),
});

export const collections = { blog };
