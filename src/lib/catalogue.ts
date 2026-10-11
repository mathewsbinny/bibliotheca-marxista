import { getCollection, type CollectionEntry } from 'astro:content';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as yaml from 'js-yaml';
import { titleHref } from './shard';
import type { AuthorLink } from './rows-shared';
import { catalogueFile, type RawTitle } from './schemas';

export type Publisher = CollectionEntry<'publishers'>;
export type Author = CollectionEntry<'authors'>;
export type Movement = CollectionEntry<'movements'>;
export type International = CollectionEntry<'internationals'>;

export interface Title extends RawTitle {
  id: string;
  publisherId: string;
  /** Site-relative URL of the title's page. */
  href: string;
}

export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-') // keeps non-Latin scripts, e.g. Chinese or Cyrillic titles
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export async function getPublishers(): Promise<Publisher[]> {
  const publishers = await getCollection('publishers');
  return publishers.sort((a, b) => a.data.name.localeCompare(b.data.name));
}

/** Every catalogue file (data/catalogues/<publisher>/*.yaml), in a fixed order so title ids are stable. */
function catalogueFiles(): string[] {
  const root = join(process.cwd(), 'data', 'catalogues');
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => join(root, f))
    .sort();
}

let titlesCache: Title[] | undefined;

/** Every title across all catalogue files, with stable per-publisher ids. */
export async function getTitles(): Promise<Title[]> {
  if (titlesCache) return titlesCache;

  const publisherIds = new Set((await getCollection('publishers')).map((p) => p.id));
  const seen = new Map<string, Set<string>>();
  const titles: Title[] = [];

  for (const file of catalogueFiles()) {
    const parsed = catalogueFile.safeParse(yaml.load(readFileSync(file, 'utf8')));
    if (!parsed.success) throw new Error(`Invalid catalogue file ${relative(process.cwd(), file)}: ${parsed.error.message}`);
    const publisherId = parsed.data.publisher;
    if (!publisherIds.has(publisherId)) throw new Error(`Catalogue file ${relative(process.cwd(), file)} names an unknown publisher "${publisherId}"`);
    const used = seen.get(publisherId) ?? new Set<string>();
    seen.set(publisherId, used);

    for (const raw of parsed.data.titles) {
      const base = raw.id ?? (slugify([raw.title, raw.year].filter(Boolean).join(' ')) || 'untitled');
      if (raw.id && used.has(base)) {
        throw new Error(`Duplicate title id "${base}" in publisher "${publisherId}"`);
      }
      let id = base;
      for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
      used.add(id);

      titles.push({ ...raw, id, publisherId, href: titleHref(publisherId, id) });
    }
  }

  titlesCache = titles.sort(
    (a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.title.localeCompare(b.title),
  );
  return titlesCache;
}

let byPublisherCache: Map<string, Title[]> | undefined;

/** Each publisher's titles, in catalogue order; built once and shared by every page. */
export async function getTitlesByPublisher(): Promise<Map<string, Title[]>> {
  if (byPublisherCache) return byPublisherCache;
  const map = new Map<string, Title[]>();
  for (const t of await getTitles()) {
    const list = map.get(t.publisherId);
    if (list) list.push(t);
    else map.set(t.publisherId, [t]);
  }
  return (byPublisherCache = map);
}

/** A publisher's titles. */
export async function getPublisherTitles(publisherId: string): Promise<Title[]> {
  return (await getTitlesByPublisher()).get(publisherId) ?? [];
}

export const STATUS_LABELS = { active: 'Active', defunct: 'Defunct', unknown: 'Status unknown' } as const;

export function yearsActive(p: Pick<Publisher['data'], 'founded' | 'dissolved' | 'status' | 'estimated'>): string {
  const circa = (field: 'founded' | 'dissolved') => (p.estimated.includes(field) ? 'c. ' : '');
  const start = p.founded ? circa('founded') + p.founded : '?';
  const end = p.dissolved ? circa('dissolved') + p.dissolved : p.status === 'active' ? 'present' : '?';
  return `${start}–${end}`;
}

/** A link that anyone can read without an account; Internet Archive lending copies are not. */
export const isFreeLink = (l: { label: string }) => !/^Borrow/.test(l.label);
export const isFree = (t: Pick<Title, 'links'>) => t.links.some(isFreeLink);

/**
 * The last year whose publications are public domain in the United States: 95 years after
 * publication, so 1930 in 2026. Later years depend on renewal and on the author's country.
 */
export const US_PUBLIC_DOMAIN_UNTIL = new Date().getFullYear() - 96;
export const isPublicDomainUS = (t: Pick<Title, 'year'>) => !!t.year && t.year <= US_PUBLIC_DOMAIN_UNTIL;

/**
 * Where an author's own text is public domain, from the year they died: copyright lasts to the end
 * of the 70th year after death in the EU, Russia, Japan and most countries, and the 50th in China
 * and many others. Translations carry the translator's copyright, which these terms do not cover.
 */
export function copyrightNotes(t: Pick<Title, 'year'>, authorDeaths: (number | undefined)[]): string[] {
  const notes: string[] = [];
  if (isPublicDomainUS(t)) notes.push('Public domain in the United States (published 95 or more years ago)');
  if (authorDeaths.length && authorDeaths.every((d) => d !== undefined)) {
    const died = Math.max(...(authorDeaths as number[]));
    const year = new Date().getFullYear();
    const caveat = '; a translation may still be under the translator’s copyright';
    if (died <= year - 71) {
      notes.push(`The author died in ${died}: the original text is public domain in the EU, Russia, Japan, China and most of the world${caveat}`);
    } else if (died <= year - 51) {
      notes.push(`The author died in ${died}: the original text is public domain where copyright lasts 50 years after death, as in China and many countries in Asia and Africa${caveat}`);
    }
  }
  return notes;
}

export function titleDate(t: Pick<Title, 'year' | 'date_note'>): string {
  return t.date_note ?? (t.year ? String(t.year) : 'n.d.');
}

/**
 * Normalises a personal name as found in catalogue records so variants compare equal:
 * "Snow, Edgar, 1905-1972." and "Edgar Snow" both become "edgar snow".
 */
// The same few hundred thousand credits are keyed many times per build.
const nameKeyCache = new Map<string, string>();

export function nameKey(name: string): string {
  let key = nameKeyCache.get(name);
  if (key === undefined) {
    key = computeNameKey(name);
    nameKeyCache.set(name, key);
  }
  return key;
}

function computeNameKey(name: string): string {
  let n = name.replace(/,?\s*\(?\d{4}\s*-\s*(\d{4})?\)?\.?/g, '').trim();
  const parts = n.split(/\s*,\s*/);
  if (parts.length === 2) n = `${parts[1]} ${parts[0]}`;
  return n
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Apostrophes and the soft and hard signs ("Leont'ev", "Leontʹev") are dropped, not spaced.
    .replace(/['’ʹʼʺ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .map(foldRomanisation)
    .join(' ');
}

/**
 * Romanisations of one Russian name, compared as one: library "Pokrovskiĭ", "Mintz", "Leont'ev"
 * and English "Pokrovsky", "Mints", "Leontyev" (as in scripts/find-author-spellings.mjs).
 */
function foldRomanisation(w: string): string {
  return w
    .replace(/(sk|ck|tsk)(ii|iy|ij|y)$/, '$1y')
    .replace(/([^aeiou])(iev|yev|jev)$/, '$1ev')
    .replace(/tz/g, 'ts')
    .replace(/x/g, 'ks')
    .replace(/yu/g, 'iu')
    .replace(/ya/g, 'ia');
}

/**
 * Every key a credit can be found under. Names in other scripts are credited as "Roman (native)",
 * e.g. "E. M. S. Namboodiripad (ഇ. എം. എസ്. നമ്പൂതിരിപ്പാട്)", so each half counts as well.
 */
export function creditKeys(name: string): string[] {
  const keys = [nameKey(name)];
  const m = name.match(/^(.+?)\s*\(([^()]+)\)\s*$/);
  if (m) keys.push(nameKey(m[1]), nameKey(m[2]));
  return keys.filter(Boolean);
}

/** The author a credited name refers to, under any of its spellings. */
export function findAuthor(index: Map<string, Author>, name: string): Author | undefined {
  for (const k of creditKeys(name)) {
    const a = index.get(k);
    if (a) return a;
  }
  return undefined;
}

/** Chinese, Korean and Vietnamese names put the family name first: "Mao Zedong", "Kim Il Sung", "Hồ Chí Minh". */
const FAMILY_NAME_FIRST = /chinese|korean|vietnamese/i;

/** The name an author is filed under: "Marx Karl", but "Mao Zedong" as written. */
export function sortName(a: Author): string {
  const words = a.data.name.split(' ');
  return FAMILY_NAME_FIRST.test(a.data.nationality ?? '') ? a.data.name : [words.at(-1), ...words.slice(0, -1)].join(' ');
}

export async function getAuthors(): Promise<Author[]> {
  const authors = await getCollection('authors');
  // Accents and case are ignored, so "Lê Duẩn" files with "Le" and "Ēriks" with "Eriks".
  return authors.sort((a, b) => sortName(a).localeCompare(sortName(b), undefined, { sensitivity: 'base' }));
}

let authorIndexCache: Map<string, Author> | undefined;

/** Maps every known spelling of each author's name to the author. */
export async function getAuthorIndex(): Promise<Map<string, Author>> {
  if (authorIndexCache) return authorIndexCache;
  const index = new Map<string, Author>();
  for (const a of await getAuthors()) {
    for (const n of [a.data.name, ...a.data.alternate_names]) index.set(nameKey(n), a);
  }
  return (authorIndexCache = index);
}

let creditIndexCache: Map<string, number[]> | undefined;

/**
 * Positions (in getTitles order) of the titles crediting each normalised name as author, editor
 * or translator. Built once, so an author page looks up its names instead of scanning every title.
 */
async function getCreditIndex(): Promise<Map<string, number[]>> {
  if (creditIndexCache) return creditIndexCache;
  const index = new Map<string, number[]>();
  (await getTitles()).forEach((t, i) => {
    for (const key of new Set([...t.authors, ...t.editors, ...t.translators].flatMap(creditKeys))) {
      const list = index.get(key);
      if (list) list.push(i);
      else index.set(key, [i]);
    }
  });
  return (creditIndexCache = index);
}

/** Catalogue titles credited to an author (as author, editor or translator) under any spelling. */
export async function getTitlesByAuthor(author: Author): Promise<Title[]> {
  const [titles, index] = [await getTitles(), await getCreditIndex()];
  const positions = new Set<number>();
  for (const n of [author.data.name, ...author.data.alternate_names]) {
    for (const i of index.get(nameKey(n)) ?? []) positions.add(i);
  }
  return [...positions].sort((a, b) => a - b).map((i) => titles[i]);
}

/** Distinct individual languages across titles ("English, Russian" counts as both). */
export function languagesOf(titles: Title[]): string[] {
  return [...new Set(titles.flatMap((t) => t.language.split(', ')))].sort();
}

/** Lower-cased text a title is matched against by the catalogue filters. */
export function searchText(t: Title, publisherName?: string): string {
  return [
    t.title, t.subtitle, t.original_title, t.series, t.notes, t.isbn,
    ...t.authors, ...t.editors, ...t.translators, publisherName,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** Text a title is searched by that its table row does not show: ISBN, original title, notes, editors, translators. */
export function hiddenSearchText(t: Title): string {
  return [t.original_title, t.notes, t.isbn, ...t.editors, ...t.translators].filter(Boolean).join(' ');
}

/** Each credited author with the id of their page; an empty list when none of them has a page. */
export function authorLinks(authors: string[], authorIndex: Map<string, Author>): AuthorLink[] {
  const links: AuthorLink[] = authors.map((name) => [name, findAuthor(authorIndex, name)?.id ?? '']);
  return links.some(([, id]) => id) ? links : [];
}

export function names(list: string[]): string {
  if (list.length <= 2) return list.join(' & ');
  return `${list.slice(0, -1).join(', ')} & ${list.at(-1)}`;
}

export async function getMovements(): Promise<Movement[]> {
  const movements = await getCollection('movements');
  return movements.sort((a, b) => a.data.country.localeCompare(b.data.country) || a.data.name.localeCompare(b.data.name));
}

/** A work of a movement: a catalogued title (with its page) or one known from a library or archive record. */
export interface MovementWork {
  title: string;
  subtitle?: string;
  authors: string[];
  year?: number;
  date: string;
  language?: string;
  publisher: string;
  publisherId?: string;
  place?: string;
  /** The title's page in this catalogue, when it is catalogued here. */
  href?: string;
  notes?: string;
  links: { label: string; url: string }[];
  sources: { title: string; url?: string }[];
}

/**
 * A movement's works: catalogued titles credited to any of its names or issued by its presses, and the works its file
 * lists, linked to their catalogue page when the publisher's catalogue has the same title and year.
 */
export async function getMovementWorks(m: Movement | International, presses: string[] = [], years?: [number, number]): Promise<MovementWork[]> {
  const [titles, publishers] = [await getTitles(), await getPublishers()];
  const publisherName = new Map(publishers.map((p) => [p.id, p.data.name]));
  const credited = new Set([m.data.name, ...m.data.alternate_names, ...m.data.credits].map(nameKey));
  const fromTitle = (t: Title): MovementWork => ({
    title: t.title, subtitle: t.subtitle, authors: t.authors, year: t.year, date: titleDate(t), language: t.language,
    publisher: publisherName.get(t.publisherId) ?? t.publisherId, publisherId: t.publisherId, href: t.href,
    notes: t.notes, links: t.links, sources: t.sources,
  });
  // A movement's years bound its credited titles too: later editions belong to other houses.
  if (!years && m.collection === 'movements' && m.data.founded) years = [m.data.founded, (m.data.dissolved ?? new Date().getFullYear()) + 1];
  const inYears = (t: Title) => !years || !t.year || (t.year >= years[0] && t.year <= years[1]);
  // A movement lists what was printed abroad: titles from home houses (or exile houses already
  // filed under its country) are on the globe under the country already.
  const publisherById = new Map(publishers.map((p) => [p.id, p.data]));
  const abroad = (t: Title) => {
    if (m.collection !== 'movements') return true;
    const p = publisherById.get(t.publisherId);
    if (!p) return true;
    if (m.data.region) return p.region !== m.data.region;
    return p.country !== m.data.country && p.home_country !== m.data.country;
  };
  // Titles a movement claims from a mixed house: its language, during the given years.
  const claims = m.collection === 'movements' ? m.data.catalogue : [];
  const claimed = (t: Title) => claims.some((c) => c.publisher.id === t.publisherId
    && (!c.language || t.language.split(', ')[0] === c.language)
    && (!c.from || (t.year ?? 0) >= c.from) && (!c.to || (t.year ?? 9999) <= c.to));
  const works: MovementWork[] = titles
    .filter((t) => presses.includes(t.publisherId) || claimed(t)
      || (inYears(t) && abroad(t) && [...t.authors, ...t.editors].some((a) => creditKeys(a).some((k) => credited.has(k))
        // A body's subdivisions count as the body: "Partido Comunista de España. Comité Ejecutivo".
        || credited.has(nameKey(a.split(/\.\s|\s\(/)[0])))))
    .map(fromTitle);
  for (const w of m.data.works) {
    const pid = w.publisher_id?.id;
    const match = pid
      ? (await getPublisherTitles(pid)).find((t) => nameKey(t.title) === nameKey(w.title) && (!w.year || t.year === w.year))
      : undefined;
    if (match) { if (!works.some((x) => x.href === match.href)) works.push({ ...fromTitle(match), notes: w.notes ?? match.notes }); continue; }
    // A listed work already catalogued under another house's record of the same title and year.
    if (works.some((x) => x.href && x.year === w.year && nameKey(x.title) === nameKey(w.title))) continue;
    works.push({
      title: w.title, subtitle: w.subtitle, authors: w.authors, year: w.year, date: w.date_note ?? (w.year ? String(w.year) : 'n.d.'),
      language: w.language, publisher: w.publisher, publisherId: pid, place: w.place, notes: w.notes, links: w.links, sources: w.sources,
    });
  }
  return works.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.title.localeCompare(b.title));
}

/** The communist internationals, oldest first. */
export async function getInternationals(): Promise<International[]> {
  const list = await getCollection('internationals');
  return list.sort((a, b) => (a.data.founded ?? 0) - (b.data.founded ?? 0) || a.data.name.localeCompare(b.data.name));
}

/**
 * An international's titles: its own presses' backlists, titles credited to it while it was active
 * (with a year's grace for late printings), and the works its file lists.
 */
export async function getInternationalWorks(i: International): Promise<MovementWork[]> {
  const presses = await getInternationalPresses(i.id);
  const end = (i.data.dissolved ?? new Date().getFullYear()) + 1;
  return getMovementWorks(i, presses.map((p) => p.id), [i.data.founded, end]);
}

/** The houses that published for an international, which the globe and publishers index leave out. */
export async function getInternationalPresses(id: string): Promise<Publisher[]> {
  return (await getCollection('publishers')).filter((p) => p.data.international?.id === id);
}
