/**
 * The build exports each publisher's titles as small JSON files, which the catalogue database is
 * built from (scripts/build-db.mjs); a title's file is chosen by hashing its id. Also the title
 * page's URL, which the pages and the API share.
 */

/** Titles per data file, on average. */
export const TITLES_PER_CHUNK = 400;

export function chunkCount(titles: number): number {
  return Math.max(1, Math.ceil(titles / TITLES_PER_CHUNK));
}

/** FNV-1a hash of a title id, reduced to one of a publisher's data files. */
export function chunkOf(id: string, chunks: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % chunks;
}

/** URL of a title's page, rendered by the catalogue API (server/book.mjs) so that search engines index it. */
export function titleHref(publisherId: string, id: string): string {
  return `/book/${encodeURIComponent(publisherId)}/${encodeURIComponent(id)}`;
}
