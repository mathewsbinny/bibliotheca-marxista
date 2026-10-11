import { z } from 'astro/zod';

/** A web address: only http and https, so imported data can never carry a javascript: or data: link. */
export const webUrl = () => z.url({ protocol: /^https?$/ });

export const source = z.object({
  title: z.string(),
  url: webUrl().optional(),
});

/**
 * A person's or a publisher's records in other catalogues, for linked data: Wikidata, VIAF, the
 * Library of Congress name authority file, the German National Library's GND, ISNI and the BnF.
 * Filled in from Wikidata by scripts/find-author-variants.mjs and scripts/link-publishers.mjs.
 */
export const identifiers = z.object({
  wikidata: z.string().regex(/^Q\d+$/),
  viaf: z.string().regex(/^\d+$/),
  lcnaf: z.string().regex(/^[a-z]{1,3}\d+$/),
  gnd: z.string().regex(/^[\dX-]+$/),
  isni: z.string().regex(/^\d{15}[\dX]$/),
  bnf: z.string().regex(/^\d{8}[0-9bcdfghjkmnpqrstvwxz]$/),
}).partial().optional();

/** The address of each identifier's record. */
export const IDENTIFIER_URLS: Record<string, { label: string; url: (id: string) => string }> = {
  wikidata: { label: 'Wikidata', url: (id) => `https://www.wikidata.org/wiki/${id}` },
  viaf: { label: 'VIAF', url: (id) => `https://viaf.org/viaf/${id}` },
  lcnaf: { label: 'Library of Congress', url: (id) => `https://id.loc.gov/authorities/names/${id}` },
  gnd: { label: 'GND', url: (id) => `https://d-nb.info/gnd/${id}` },
  isni: { label: 'ISNI', url: (id) => `https://isni.org/isni/${id}` },
  bnf: { label: 'BnF', url: (id) => `https://catalogue.bnf.fr/ark:/12148/cb${id}` },
};

/** An entity's identifiers as links, in a fixed order: [{ label, url }]. */
export function identifierLinks(ids: Partial<Record<string, string>> | undefined) {
  return Object.entries(IDENTIFIER_URLS)
    .filter(([key]) => ids?.[key])
    .map(([key, { label, url }]) => ({ label, url: url(ids![key]!) }));
}

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

/**
 * Corrections to titles, kept apart from the catalogue files (which an import rewrites):
 * data/corrections/<publisher>.yaml. Each names a title by its id, which stays its address however
 * its title or year change, and either replaces some of its fields or removes it (a duplicate).
 * Written by scripts/review-reports.mjs from readers' reports, or by hand.
 */
export const correction = z.object({
  id: z.string(),
  /** The reader's report it answers (server/reports.mjs). */
  report: z.number().int().optional(),
  note: z.string().optional(),
  // Spelled out rather than title.partial(): that would bring the defaults with it, and an empty
  // correction would clear a title's authors and links.
  set: z.object({
    title: z.string(),
    subtitle: z.string(),
    original_title: z.string(),
    authors: z.array(z.string()),
    editors: z.array(z.string()),
    translators: z.array(z.string()),
    year: z.number().int(),
    date_note: z.string(),
    edition: z.string(),
    series: z.string(),
    language: z.string(),
    pages: z.number().int(),
    isbn: z.string(),
    notes: z.string(),
    links: z.array(link),
    sources: z.array(source),
  }).partial().strict().optional(),
  remove: z.boolean().optional(),
});

export const correctionsFile = z.object({
  publisher: z.string(),
  corrections: z.array(correction),
});

export type Correction = z.infer<typeof correction>;
