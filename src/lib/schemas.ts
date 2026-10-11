import { z } from 'astro/zod';

/** A web address: only http and https, so imported data can never carry a javascript: or data: link. */
export const webUrl = () => z.url({ protocol: /^https?$/ });

export const source = z.object({
  title: z.string(),
  url: webUrl().optional(),
});

export const link = z.object({
  label: z.string(),
  url: webUrl(),
});

export const title = z.object({
  /** Optional stable slug; generated from title + year when omitted. */
  id: z.string().regex(/^[a-z0-9-]+$/).optional(),
  title: z.string(),
  subtitle: z.string().optional(),
  original_title: z.string().optional(),
  authors: z.array(z.string()).default([]),
  editors: z.array(z.string()).default([]),
  translators: z.array(z.string()).default([]),
  year: z.number().int().optional(),
  /** Free-text qualifier for uncertain dates, e.g. "c. 1950" or "n.d." */
  date_note: z.string().optional(),
  edition: z.string().optional(),
  series: z.string().optional(),
  language: z.string(),
  pages: z.number().int().optional(),
  isbn: z.string().optional(),
  notes: z.string().optional(),
  /** Digitised copies, e.g. marxists.org, archive.org */
  links: z.array(link).default([]),
  sources: z.array(source).default([]),
  /** True once checked against a bibliographic source or physical copy. */
  verified: z.boolean().default(false),
});

/**
 * Catalogue files hold a list of titles for one publisher. A publisher's backlist may be split
 * across several files, e.g. data/catalogues/flph/1950s.yaml. They are read by src/lib/catalogue.ts,
 * not as a content collection: Astro's content store holds a collection as one serialised string,
 * which the whole catalogue (some 900,000 titles) is longer than JavaScript allows.
 */
export const catalogueFile = z.object({
  publisher: z.string(),
  titles: z.array(title),
});

export type RawTitle = z.infer<typeof title>;
