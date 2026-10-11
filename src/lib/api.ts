/**
 * The catalogue API (server/server.mjs), which serves search, the large tables page by page, title
 * records and the data download. Same origin by default (/api, proxied in development; see
 * astro.config.mjs); PUBLIC_API_URL points the site at an API on another host.
 */
import type { Criteria } from './filters';
import type { Row } from './rows-shared';

export const API = (import.meta.env.PUBLIC_API_URL as string | undefined)?.replace(/\/$/, '') ?? '/api';

export interface TitlePage {
  /** Given for the first page (offset 0) only. */
  total?: number;
  rows: Row[];
}

/** The API's parameters for a table or search: the reader's criteria within a scope (a publisher or an author). */
export function titleParams(c: Criteria, scope: Record<string, string> = {}): URLSearchParams {
  const p = new URLSearchParams(scope);
  if (c.terms.length) p.set('q', c.terms.join(' '));
  if (c.lang) p.set('lang', c.lang);
  if (c.pub) p.set('pub', c.pub);
  if (c.country) p.set('country', c.country);
  if (c.series) p.set('series', c.series);
  if (c.from !== -Infinity) p.set('from', String(c.from));
  if (c.to !== Infinity) p.set('to', String(c.to));
  if (c.verified) p.set('verified', c.verified);
  if (c.access === 'free') p.set('free', '1');
  if (c.sort) p.set('sort', c.sort);
  return p;
}

/** How a search's titles divide: [value, count] pairs by language, country, publisher id and decade. */
export type Facets = Record<'lang' | 'country' | 'pub' | 'decade', [string | number, number][]>;

export async function fetchFacets(params: URLSearchParams, signal?: AbortSignal): Promise<Facets> {
  const p = new URLSearchParams(params);
  p.delete('sort');
  const res = await fetch(`${API}/facets?${p}`, { signal });
  if (!res.ok) throw new Error(`The catalogue could not be counted (${res.status}).`);
  return res.json();
}

export interface Suggestion {
  kind: 'author' | 'publisher' | 'series';
  label: string;
  href: string;
  titles: number;
}

/** Authors, publishers and series whose names have a word starting with what was typed. */
export async function fetchSuggestions(q: string, signal?: AbortSignal): Promise<Suggestion[]> {
  const res = await fetch(`${API}/suggest?${new URLSearchParams({ q })}`, { signal });
  if (!res.ok) return [];
  return res.json();
}

/** A page of titles. */
export async function fetchTitles(params: URLSearchParams, offset: number, limit: number, signal?: AbortSignal): Promise<TitlePage> {
  const p = new URLSearchParams(params);
  p.set('offset', String(offset));
  p.set('limit', String(limit));
  const res = await fetch(`${API}/titles?${p}`, { signal });
  if (!res.ok) throw new Error(`The catalogue could not be searched (${res.status}).`);
  return res.json();
}
