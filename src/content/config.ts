import { defineCollection, z } from "astro:content";

const imageWithAlt = z.object({
  heroImage: z.string(),
  heroImageAlt: z.string(),
});

const noImage = z.object({
  heroImage: z.undefined(),
  heroImageAlt: z.undefined(),
});

const optionalHeroImage = imageWithAlt.or(noImage);

const schema = z
  .object({
    title: z.string(),
    description: z.string(),
    // Transform string to Date object
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    tags: z.array(z.string()).optional(),
  })
  .and(optionalHeroImage);

const blog = defineCollection({
  // Type-check frontmatter using a schema
  schema,
});

export const collections = { blog };

// "heroImage and heroImageAlt must be both defined or both undefined",
