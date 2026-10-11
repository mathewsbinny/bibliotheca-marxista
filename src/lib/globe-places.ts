/**
 * Where publishers and movements go on the globe, shared by the globe and the home page's count.
 */
import { getMovementWorks, getMovements, getPublishers, getTitles } from './catalogue';
import { COUNTRIES, REGIONS, regionLabel } from './globe';

export const regionByLabel = new Map(Object.entries(REGIONS).map(([r, d]) => [regionLabel(r, d), d]));

/** A name the globe can place: a country, or a region under its label. */
export const isPlace = (name: string) => Boolean(COUNTRIES[name] || regionByLabel.has(name));

/**
 * The pin an entry goes under: its region ("Taiwan (China)", "Estonia") or its country. A house
 * filed under a former Soviet republic as a country (from before 1917 or after 1991) is pinned
 * with that republic's Soviet-era houses.
 */
export function pinName(d: { country: string; region?: string }, what: string): string {
  if (!d.region) return d.country;
  const r = REGIONS[d.region];
  if (!r || r.country !== d.country) throw new Error(`Globe: unknown region "${d.region}" of ${d.country} (${what}); add it to REGIONS in src/lib/globe.ts`);
  return regionLabel(d.region, r);
}

/**
 * The countries shown on the globe: those with publishers (other than the internationals' own
 * presses), exile presses or movements. The Soviet republics count as countries; island regions
 * listed under another country (Taiwan, Puerto Rico, Hawaii) do not.
 */
export async function getGlobeCountries(): Promise<Set<string>> {
  const names = new Set<string>();
  for (const p of await getPublishers()) {
    if (!p.data.international) names.add(pinName(p.data, `publisher ${p.id}`));
    if (p.data.home_country && p.data.home_country !== p.data.country) names.add(p.data.home_country);
  }
  for (const m of await getMovements()) names.add(pinName(m.data, `movement ${m.id}`));
  return new Set([...names].filter((n) => COUNTRIES[n] || regionByLabel.get(n)?.standalone));
}

let titlePlacesCache: Map<string, string[]> | undefined;

/**
 * The globe pins each title is listed under, keyed by its href: its publisher's pin, the home
 * country of an exile press, and the pins of movements that claim it (titles printed abroad).
 * Used by the country filter of the all-titles search.
 */
export async function getTitlePlaces(): Promise<Map<string, string[]>> {
  if (titlePlacesCache) return titlePlacesCache;
  const publishers = new Map((await getPublishers()).map((p) => [p.id, p]));
  const places = new Map<string, Set<string>>();
  const add = (href: string, place: string) => (places.get(href) ?? places.set(href, new Set()).get(href)!).add(place);
  for (const t of await getTitles()) {
    const p = publishers.get(t.publisherId);
    if (!p) continue;
    add(t.href, pinName(p.data, `publisher ${p.id}`));
    if (p.data.home_country && p.data.home_country !== p.data.country) add(t.href, p.data.home_country);
  }
  for (const m of await getMovements()) {
    const pin = pinName(m.data, `movement ${m.id}`);
    for (const w of await getMovementWorks(m)) if (w.href) add(w.href, pin);
  }
  titlePlacesCache = new Map([...places].map(([href, set]) => [href, [...set]]));
  return titlePlacesCache;
}
