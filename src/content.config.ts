import { defineCollection, type ImageFunction } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

// Hand-written posts import a co-located image; Red posts name a file it
// published under public/assets/<slug>/.
const imageWithAlt = (image: ImageFunction) =>
  z.object({
    heroImage: z
      .string()
      .regex(/^\/assets\/[a-z0-9-]+\/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|gif|webp)$/)
      .or(image()),
    heroImageAlt: z.string(),
  });

const noImage = z.object({
  heroImage: z.undefined().optional(),
  heroImageAlt: z.undefined().optional(),
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
        draft: z.boolean().optional(),
        media: z.enum(["note", "link-post", "long-form"]).optional(),
        author: z.string().optional(),
        externalUrl: z.url().nullable().optional(),
        standardDocument: z.string().startsWith("at://").nullable().optional(),
        publicationHash: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      })
      .and(imageWithAlt(image).or(noImage)),
});

export const collections = { blog };
