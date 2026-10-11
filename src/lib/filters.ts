/** Client-side catalogue filtering shared by the publisher tables and the all-titles search. */

export interface FilterRecord {
  search: string;
  year?: number;
  lang: string;
  pub: string;
  verified: boolean;
  free: boolean;
}

export type SortKey = '' | 'title' | 'author' | 'publisher' | 'year' | 'year-desc';

/** The values a row is sorted by; empty strings and a missing year sort last. */
export interface SortRecord {
  title: string;
  author: string;
  publisher: string;
  year?: number;
}

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Compares two rows for the chosen sort; returns 0 for the default (catalogue) order. */
export function compareRows(a: SortRecord, b: SortRecord, key: SortKey): number {
  if (key === 'year' || key === 'year-desc') {
    if (!a.year || !b.year) return (a.year ? 0 : 1) - (b.year ? 0 : 1);
    return key === 'year' ? a.year - b.year : b.year - a.year;
  }
  if (!key) return 0;
  const x = a[key], y = b[key];
  if (!x || !y) return (x ? 0 : 1) - (y ? 0 : 1);
  return collator.compare(x, y);
}

export interface Criteria {
  terms: string[];
  from: number;
  to: number;
  lang: string;
  pub: string;
  /** A globe pin: titles listed under that country or region (the all-titles search only). */
  country: string;
  /** A series, by its name without volume numbers (the all-titles search only). */
  series: string;
  /** '1' verified only, '0' unverified only, '' all. */
  verified: '' | '1' | '0';
  /** 'free' for titles with a copy anyone can read. */
  access: '' | 'free';
  sort: SortKey;
}

const FIELDS = ['q', 'series', 'from', 'to', 'lang', 'country', 'pub', 'verified', 'access', 'sort'] as const;

/** Seeds the form from the page URL so searches can be linked to, e.g. /titles?q=lenin */
export function restoreFromUrl(form: HTMLFormElement): boolean {
  const params = new URLSearchParams(location.search);
  for (const name of FIELDS) {
    const input = form.elements.namedItem(name) as HTMLInputElement | null;
    if (!input || !params.has(name)) continue;
    input.value = params.get(name)!;
  }
  return FIELDS.some((name) => params.has(name));
}

export function readCriteria(form: HTMLFormElement): Criteria {
  const data = new FormData(form);
  const get = (k: string) => String(data.get(k) ?? '').trim();
  const next = new URLSearchParams();
  for (const name of FIELDS) if (get(name)) next.set(name, get(name));
  const qs = next.toString();
  history.replaceState(null, '', qs ? `?${qs}` : location.pathname);

  return {
    terms: get('q').toLowerCase().split(/\s+/).filter(Boolean),
    from: Number(get('from')) || -Infinity,
    to: Number(get('to')) || Infinity,
    lang: get('lang'),
    pub: get('pub'),
    country: get('country'),
    series: get('series'),
    verified: (['1', '0'].includes(get('verified')) ? get('verified') : '') as Criteria['verified'],
    access: (get('access') === 'free' ? 'free' : '') as Criteria['access'],
    sort: get('sort') as SortKey,
  };
}

export function matches(r: FilterRecord, c: Criteria): boolean {
  const yearFiltered = c.from !== -Infinity || c.to !== Infinity;
  if (yearFiltered && !(r.year && r.year >= c.from && r.year <= c.to)) return false;
  if (c.lang && !r.lang.split(', ').includes(c.lang)) return false;
  if (c.pub && r.pub !== c.pub) return false;
  if (c.verified && r.verified !== (c.verified === '1')) return false;
  if (c.access === 'free' && !r.free) return false;
  return c.terms.every((term) => r.search.includes(term));
}
