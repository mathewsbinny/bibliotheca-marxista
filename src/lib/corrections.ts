/**
 * Applies corrections (data/corrections/<publisher>.yaml, see `correction` in ./schemas) to titles
 * whose ids are already assigned, so that a corrected title keeps its address. Kept free of Astro so
 * the tests and scripts can use it.
 */

export interface TitleCorrection {
  id: string;
  set?: Record<string, unknown>;
  remove?: boolean;
}

/**
 * The titles with their corrections applied, and the corrections that name no title (an import
 * may have renamed or dropped it; they are reported, not silently lost).
 */
export function applyCorrections<T extends { id: string; publisherId: string }>(
  titles: T[],
  corrections: Map<string, TitleCorrection[]>,
): { titles: T[]; orphans: string[] } {
  if (!corrections.size) return { titles, orphans: [] };
  const pending = new Map<string, TitleCorrection[]>();
  for (const [publisherId, list] of corrections) {
    for (const c of list) {
      const key = `${publisherId}/${c.id}`;
      pending.set(key, [...(pending.get(key) ?? []), c]);
    }
  }
  const out: T[] = [];
  for (const t of titles) {
    const key = `${t.publisherId}/${t.id}`;
    const list = pending.get(key);
    if (!list) {
      out.push(t);
      continue;
    }
    pending.delete(key);
    if (list.some((c) => c.remove)) continue;
    // Later corrections win over earlier ones, field by field.
    out.push(Object.assign({}, t, ...list.map((c) => c.set ?? {})));
  }
  return { titles: out, orphans: [...pending.keys()] };
}
