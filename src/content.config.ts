import { defineCollection, reference } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { identifiers, link, source, webUrl } from './lib/schemas';

/** One file per publishing house: data/publishers/<id>.yaml */
const publishers = defineCollection({
  loader: glob({ pattern: '*.{yaml,yml}', base: './data/publishers' }),
  schema: z.object({
    name: z.string(),
    alternate_names: z.array(z.string()).default([]),
    country: z.string(),
    city: z.string().optional(),
    founded: z.number().int().optional(),
    dissolved: z.number().int().optional(),
    status: z.enum(['active', 'defunct', 'unknown']),
    /** Years inferred from the catalogue rather than a documented history, shown as "c. 1983". */
    estimated: z.array(z.enum(['founded', 'dissolved'])).default([]),
    affiliation: z.string().optional(),
    /**
     * For an exile or émigré press: the country of the movement it served (e.g. the Tudeh Party's
     * press in Stockholm serves Iran). It stays filed under `country`, and is also listed under the
     * home country as published abroad.
     */
    home_country: z.string().optional(),
    /** An island with its own globe pin within `country`, e.g. Puerto Rico or Taiwan (see REGIONS in src/lib/globe.ts). */
    region: z.string().optional(),
    /** The communist international this house published for; such houses are listed on the International page rather than the globe. */
    international: reference('internationals').optional(),
    /** The house this one was an imprint, series or club of. */
    parent: reference('publishers').optional(),
    predecessor: reference('publishers').optional(),
    successor: reference('publishers').optional(),
    languages: z.array(z.string()).default([]),
    website: webUrl().optional(),
    description: z.string(),
    /** Names the house traded under, oldest first. */
    name_history: z
      .array(
        z.object({
          name: z.string(),
          from: z.number().int().optional(),
          to: z.number().int().optional(),
          note: z.string().optional(),
        }),
      )
      .default([]),
    sources: z.array(source).default([]),
    identifiers,
  }),
});

const authors = defineCollection({
  loader: glob({ pattern: '*.{yaml,yml}', base: './data/authors' }),
  schema: z.object({
    name: z.string(),
    /** Other spellings used in catalogue records, e.g. "Snow, Edgar" — used to find their editions. */
    alternate_names: z.array(z.string()).default([]),
    born: z.number().int().optional(),
    died: z.number().int().optional(),
    /** Period of activity when the dates of birth and death are not known, e.g. "1960s–1980s". */
    active: z.string().optional(),
    nationality: z.string().optional(),
    /** Listed among the major Marxist theorists and leaders at the top of the authors page. */
    featured: z.boolean().default(false),
    description: z.string(),
    sources: z.array(source).default([]),
    identifiers,
    /** First editions of the author's books. */
    works: z.array(
      z.object({
        title: z.string(),
        subtitle: z.string().optional(),
        year: z.number().int(),
        /** Imprint as printed, e.g. "Victor Gollancz" — may be a house not in this catalogue. */
        publisher: z.string(),
        place: z.string().optional(),
        /** Links the work to a house in this catalogue. */
        publisher_id: reference('publishers').optional(),
        role: z.enum(['author', 'editor', 'translator']).default('author'),
        notes: z.string().optional(),
        links: z.array(link).default([]),
        sources: z.array(source).default([]),
        verified: z.boolean().default(false),
      }),
    ),
  }),
});

/** A work listed directly: a catalogued title (give publisher_id) or one known from a library or archive record. */
const work = z.object({
  title: z.string(),
  subtitle: z.string().optional(),
  authors: z.array(z.string()).default([]),
  year: z.number().int().optional(),
  date_note: z.string().optional(),
  language: z.string().optional(),
  pages: z.number().int().optional(),
  /** The real publisher, as printed. */
  publisher: z.string(),
  place: z.string().optional(),
  publisher_id: reference('publishers').optional(),
  notes: z.string().optional(),
  links: z.array(link).default([]),
  sources: z.array(source).default([]),
});

/**
 * One file per movement whose own publications were produced abroad, by foreign or exile
 * presses: data/movements/<id>.yaml. Each work keeps its real publisher; the movement places it
 * on its country, and a country with a movement but no home publisher is shown on the globe.
 */
const movements = defineCollection({
  loader: glob({ pattern: '*.{yaml,yml}', base: './data/movements' }),
  schema: z.object({
    name: z.string(),
    alternate_names: z.array(z.string()).default([]),
    country: z.string(),
    region: z.string().optional(),
    founded: z.number().int().optional(),
    dissolved: z.number().int().optional(),
    status: z.enum(['active', 'defunct', 'unknown']),
    affiliation: z.string().optional(),
    description: z.string(),
    sources: z.array(source).default([]),
    /** Names the catalogue credits the movement's own works to (its leaders, organs or the movement itself). */
    credits: z.array(z.string()).default([]),
    /**
     * Titles it claims from a house that printed for many: e.g. the German titles a Moscow press
     * issued for the exiled KPD in 1933–1938. They stay in the house's backlist.
     */
    catalogue: z
      .array(
        z.object({
          publisher: reference('publishers'),
          language: z.string().optional(),
          from: z.number().int().optional(),
          to: z.number().int().optional(),
        }),
      )
      .default([]),
    /** Works listed directly: a catalogued title (give publisher_id) or one known from a library or archive record. */
    works: z.array(work).default([]),
  }),
});

/**
 * One file per communist international: data/internationals/<id>.yaml. Its works are the titles
 * of its own presses (publishers with `international` set), titles credited to its names, and the
 * works listed here. They are shown on the International page, oldest international first.
 */
const internationals = defineCollection({
  loader: glob({ pattern: '*.{yaml,yml}', base: './data/internationals' }),
  schema: z.object({
    name: z.string(),
    alternate_names: z.array(z.string()).default([]),
    founded: z.number().int(),
    dissolved: z.number().int().optional(),
    status: z.enum(['active', 'defunct', 'unknown']),
    /** Its tendency, e.g. "Marxist–Leninist" or "Trotskyist". */
    affiliation: z.string().optional(),
    /** One or two sentences shown under its box on the International page. */
    summary: z.string(),
    description: z.string(),
    sources: z.array(source).default([]),
    /** Names the catalogue credits its works to, e.g. its executive committee or congresses. */
    credits: z.array(z.string()).default([]),
    works: z.array(work).default([]),
  }),
});

// The catalogues (data/catalogues) are read by src/lib/catalogue.ts; see src/lib/schemas.ts.
export const collections = { publishers, authors, movements, internationals };
