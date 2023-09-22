import { defineCollection, z, type ImageFunction } from "astro:content";

const imageWithAlt = (image: ImageFunction) =>
  z.object({
    heroImage: image().refine((img) => img.width >= 480, {
      message: "Cover image must be at least 480 pixels wide!",
    }),
    heroImageAlt: z.string(),
  });

const noImage = z.object({
  heroImage: z.undefined(),
  heroImageAlt: z.undefined(),
});

const blog = defineCollection({
  // Type-check frontmatter using a schema
  schema: ({ image }) =>
    z
      .object({
        title: z.string(),
        description: z.string(),
        // Transform string to Date object
        pubDate: z.coerce.date(),
        updatedDate: z.coerce.date().optional(),
        tags: z.array(z.string()).optional(),
      })
      .and(imageWithAlt(image).or(noImage)),
});

export const collections = { blog };
