/**
 * Large catalogue tables (a publisher's backlist, an author's editions) put only their first rows in
 * the page; the catalogue API (server/) filters, sorts and serves the rest page by page, as compact
 * rows. Shared by the build and the browser.
 */

/** Tables with more titles than this load progressively. */
export const PROGRESSIVE_ABOVE = 300;
/** Rows written into the page of a progressive table. */
export const INITIAL_ROWS = 200;
/** Rows fetched and drawn at a time as the reader scrolls. */
export const BATCH_ROWS = 200;
/** Titles per page of a publisher's plain list (for readers without JavaScript). */
export const PLAIN_PER_PAGE = 1000;

export const plainPageCount = (rows: number) => Math.max(1, Math.ceil(rows / PLAIN_PER_PAGE));

/** Bit flags of a row. */
export const VERIFIED = 1;
export const FREE = 2;

/**
 * One title as a compact array (built by server/query.mjs):
 * [href, title, subtitle, series, authors, date, year, language, flags, publisher id, search-only text,
 *  author links]. Empty strings and 0 stand for missing values. The author links are each credited
 * author with the id of their page ('' when they have none), or an empty list when none has a page.
 */
export type Row = [string, string, string, string, string, string, number, string, number, string, string, AuthorLink[]];
/** A credited author and the id of their page, or '' when they have none. */
export type AuthorLink = [string, string];

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
