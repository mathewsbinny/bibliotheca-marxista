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
    from: int(params.get('from'), 'from', 0, 3000),
    to: int(params.get('to'), 'to', 0, 3000),
    verified,
    free: free === '1',
    sort,
    offset: int(params.get('offset'), 'offset', 0, MAX_OFFSET) ?? 0,
    limit: int(params.get('limit'), 'limit', 1, MAX_LIMIT) ?? 50,
  };
}

/** The SQL (and bound values) for a page of titles and for their total. */
export function titleQuery(p) {
  const where = [];
  const args = [];
  let from = 'titles t';
  if (p.match) {
    from = 'titles_fts JOIN titles t ON t.rowid = titles_fts.rowid';
    where.push('titles_fts MATCH ?');
    args.push(p.match);
  }
  if (p.pub) { where.push('t.publisher_id = ?'); args.push(p.pub); }
  if (p.author) { where.push('t.rowid IN (SELECT title_rowid FROM title_author WHERE author_id = ?)'); args.push(p.author); }
  if (p.lang) { where.push('t.rowid IN (SELECT title_rowid FROM title_lang WHERE lang = ?)'); args.push(p.lang); }
  if (p.country) { where.push('t.rowid IN (SELECT title_rowid FROM title_place WHERE place = ?)'); args.push(p.country); }
  if (p.from != null) { where.push('t.year >= ?'); args.push(p.from); }
  if (p.to != null) { where.push('t.year <= ?'); args.push(p.to); }
  if (p.verified) { where.push('t.verified = ?'); args.push(Number(p.verified)); }
  if (p.free) where.push('t.free = 1');
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
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

/** A database row as the site's compact table row (Row in src/lib/rows-shared.ts). */
export const toRow = (r) => [
  r.href, r.title, r.subtitle ?? '', r.series ?? '', r.authors_text, r.date, r.year ?? 0, r.language,
  (r.verified ? 1 : 0) | (r.free ? 2 : 0), r.publisher_id, '', JSON.parse(r.author_links),
];
