/**
 * The catalogue API's title queries: request parameters checked and turned into SQL for the
 * database built by scripts/build-db.mjs. Every value is bound as a parameter, never written into
 * the SQL text.
 */

export class BadRequest extends Error {}

const SORTS = {
  title: 't.sort_title, t.year_sort',
  author: 't.sort_author, t.sort_title',
  publisher: 't.sort_publisher, t.year_sort, t.sort_title',
  year: 't.year_sort, t.sort_title',
  // Undated titles sort last in both directions.
  'year-desc': 't.year IS NULL, t.year DESC, t.sort_title',
};
/** Catalogue order (as the site lists titles): by year, then title. */
const CATALOGUE_ORDER = 't.year_sort, t.sort_title';
/** Relevance, weighting a match in the title above one in the notes (columns as in titles_fts). */
const RELEVANCE = 'bm25(titles_fts, 10, 4, 4, 6, 2, 1, 1, 2)';

export const MAX_LIMIT = 200;
export const MAX_OFFSET = 100_000;
const ID = /^[a-z0-9-]{1,120}$/;
const TEXT = /^[^\0<>]{1,120}$/u;
const SERIES = /^[^\0]{1,300}$/u;

/** A search phrase as an FTS5 query: every word must match, each as a prefix ("marx" finds "marxism"). */
export function ftsQuery(q) {
  const words = q.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!words.length) return undefined;
  return words.slice(0, 12).map((w) => `"${w}"*`).join(' ');
}

const int = (value, name, min, max) => {
  if (value == null || value === '') return undefined;
  if (!/^\d{1,6}$/.test(value)) throw new BadRequest(`${name} must be a whole number`);
  const n = Number(value);
  if (n < min || n > max) throw new BadRequest(`${name} must be between ${min} and ${max}`);
  return n;
};
const pattern = (value, name, re) => {
  if (value == null || value === '') return undefined;
  if (!re.test(value)) throw new BadRequest(`invalid ${name}`);
  return value;
};

/** The title search's parameters, checked. */
export function parseTitleParams(params) {
  const q = params.get('q') ?? '';
  if (q.length > 200) throw new BadRequest('q is too long');
  const sort = params.get('sort') ?? '';
  if (sort && !SORTS[sort]) throw new BadRequest('invalid sort');
  const verified = params.get('verified') ?? '';
  if (verified && !['0', '1'].includes(verified)) throw new BadRequest('verified must be 0 or 1');
  const free = params.get('free') ?? '';
  if (free && free !== '1') throw new BadRequest('free must be 1');
  return {
    match: ftsQuery(q),
    pub: pattern(params.get('pub'), 'pub', ID),
    author: pattern(params.get('author'), 'author', ID),
    lang: pattern(params.get('lang'), 'lang', TEXT),
    country: pattern(params.get('country'), 'country', TEXT),
    series: pattern(params.get('series'), 'series', SERIES),
    from: int(params.get('from'), 'from', 0, 3000),
    to: int(params.get('to'), 'to', 0, 3000),
    verified,
    free: free === '1',
    sort,
    offset: int(params.get('offset'), 'offset', 0, MAX_OFFSET) ?? 0,
    limit: int(params.get('limit'), 'limit', 1, MAX_LIMIT) ?? 50,
  };
}

/**
 * The FROM and WHERE of a search, and their bound values. `omit` leaves out one filter: a facet
 * counts the titles each of its values would give with the other filters as they are.
 */
function filters(p, omit) {
  const where = [];
  const args = [];
  let from = 'titles t';
  if (p.match) {
    from = 'titles_fts JOIN titles t ON t.rowid = titles_fts.rowid';
    where.push('titles_fts MATCH ?');
    args.push(p.match);
  }
  if (p.pub && omit !== 'pub') { where.push('t.publisher_id = ?'); args.push(p.pub); }
  if (p.author) { where.push('t.rowid IN (SELECT title_rowid FROM title_author WHERE author_id = ?)'); args.push(p.author); }
  if (p.series) { where.push('t.series_name = ?'); args.push(p.series); }
  if (p.lang && omit !== 'lang') { where.push('t.rowid IN (SELECT title_rowid FROM title_lang WHERE lang = ?)'); args.push(p.lang); }
  if (p.country && omit !== 'country') { where.push('t.rowid IN (SELECT title_rowid FROM title_place WHERE place = ?)'); args.push(p.country); }
  if (omit !== 'decade') {
    if (p.from != null) { where.push('t.year >= ?'); args.push(p.from); }
    if (p.to != null) { where.push('t.year <= ?'); args.push(p.to); }
  }
  if (p.verified) { where.push('t.verified = ?'); args.push(Number(p.verified)); }
  if (p.free) where.push('t.free = 1');
  return { from, whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

/** The SQL (and bound values) for a page of titles and for their total. */
export function titleQuery(p) {
  const { from, whereSql, args } = filters(p);
  const order = p.sort ? SORTS[p.sort] : p.match ? RELEVANCE : CATALOGUE_ORDER;
  return {
    rows: {
      sql: `SELECT t.href, t.title, t.subtitle, t.series, t.authors_text, t.date, t.year, t.language, t.verified, t.free,
        t.publisher_id, t.author_links FROM ${from} ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      args: [...args, p.limit, p.offset],
    },
    count: { sql: `SELECT count(*) FROM ${from} ${whereSql}`, args },
  };
}

export const FACET_SIZE = 40;
/**
 * The SQL of each facet of a search: how many of its titles are in each language, country,
 * publisher and decade (the largest first; decades in order). Each leaves out its own filter.
 */
export function facetQueries(p) {
  const among = (omit) => {
    const { from, whereSql, args } = filters(p, omit);
    return { sql: `SELECT t.rowid FROM ${from} ${whereSql}`, args };
  };
  const lang = among('lang'), country = among('country'), pub = filters(p, 'pub'), decade = filters(p, 'decade');
  const dated = `${decade.whereSql ? `${decade.whereSql} AND` : 'WHERE'} t.year IS NOT NULL`;
  return {
    lang: { sql: `SELECT lang AS value, count(*) AS n FROM title_lang WHERE title_rowid IN (${lang.sql}) GROUP BY lang ORDER BY n DESC LIMIT ${FACET_SIZE}`, args: lang.args },
    country: { sql: `SELECT place AS value, count(*) AS n FROM title_place WHERE title_rowid IN (${country.sql}) GROUP BY place ORDER BY n DESC LIMIT ${FACET_SIZE}`, args: country.args },
    pub: { sql: `SELECT t.publisher_id AS value, count(*) AS n FROM ${pub.from} ${pub.whereSql} GROUP BY t.publisher_id ORDER BY n DESC LIMIT ${FACET_SIZE}`, args: pub.args },
    decade: { sql: `SELECT t.year / 10 * 10 AS value, count(*) AS n FROM ${decade.from} ${dated} GROUP BY value ORDER BY value`, args: decade.args },
  };
}

/**
 * A series' name without the volume it numbers ("Little Lenin Library -- v. 15", "Kompassbücherei;
 * 122", "現代哲学全書, 17") or its editors ("Raskršća / Midhat Begić; Knj. 3"), so that its volumes
 * are found together. A trailing part after ";", "--" or "," is a number when it is short and has a
 * digit.
 */
export function seriesName(series) {
  let s = String(series ?? '').split('||||')[0].replace(/\s+\/\s+[^;]*/, '').trim();
  for (let m; (m = /^(.+)(?:;|\s--|,)\s*(.*)$/.exec(s)) && /\d/.test(m[2]) && m[2].length <= 25;) s = m[1].trim();
  return s.replace(/[\s.;,:-]+$/, '') || undefined;
}

/** A name as suggestions look it up: no accents or punctuation, lower case (as in scripts/build-db.mjs). */
export const suggestKey = (s) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Suggestions for what a reader has typed: authors, publishers and series with a word of their name starting so. */
export function suggestQuery(q) {
  if (q.length > 100) throw new BadRequest('q is too long');
  const key = suggestKey(q);
  if (key.length < 2) return undefined;
  return {
    // The best-known first; a name found by several of its words is listed once.
    sql: 'SELECT kind, label, href, max(weight) AS weight FROM suggest WHERE key >= ? AND key < ? GROUP BY kind, href ORDER BY weight DESC, kind, label LIMIT 10',
    args: [key, `${key}\u{10FFFF}`],
  };
}

/** A database row as the site's compact table row (Row in src/lib/rows-shared.ts). */
export const toRow = (r) => [
  r.href, r.title, r.subtitle ?? '', r.series ?? '', r.authors_text, r.date, r.year ?? 0, r.language,
  (r.verified ? 1 : 0) | (r.free ? 2 : 0), r.publisher_id, '', JSON.parse(r.author_links),
];
