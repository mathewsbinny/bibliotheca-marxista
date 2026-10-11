/**
 * Title records are published as small JSON files, one set per publisher, so a title's page loads
 * only the file holding it. A title's file is chosen by hashing its id, which the build and the
 * browser compute the same way.
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

/** URL of a title's page. */
export function titleHref(publisherId: string, id: string): string {
  return `/title/?p=${encodeURIComponent(publisherId)}&t=${encodeURIComponent(id)}`;
}
