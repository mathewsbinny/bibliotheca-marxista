/**
 * Wikidata for the scripts: cached requests (.cache/wikidata) at the pace Wikidata asks for, a
 * publishing house's item found by its names and country, and the identifiers the site links to.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './openlibrary.mjs';

const CACHE = join(ROOT, '.cache', 'wikidata');
mkdirSync(CACHE, { recursive: true });

let last = 0;
export async function getJson(url) {
  const file = join(CACHE, createHash('sha1').update(url).digest('hex') + '.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  let res;
  for (let attempt = 1; ; attempt++) {
    const wait = last + 2000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    res = await fetch(url, { headers: { 'User-Agent': 'LeftBacklist/1.0 (bibliographic research)' }, signal: AbortSignal.timeout(60_000) });
    if (res.ok) break;
    // Wikidata asks a client that searches quickly to wait: as long as it says, or longer each time.
    if ((res.status !== 429 && res.status < 500) || attempt >= 6) throw new Error(`HTTP ${res.status} ${url}`);
    const after = Number(res.headers.get('retry-after')) || 15 * attempt;
    await new Promise((r) => setTimeout(r, after * 1000));
  }
  const json = await res.json();
  writeFileSync(file, JSON.stringify(json));
  return json;
}
export const entity = async (qid) => (await getJson(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`)).entities[qid];
export const search = async (q, lang) =>
  (await getJson(`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&type=item&limit=7&language=${lang}&search=${encodeURIComponent(q)}`)).search ?? [];

export const plain = (s) => String(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const yearOfTime = (claim) => {
  const t = claim?.mainsnak?.datavalue?.value?.time;
  const m = t && /^[+]?(\d{4})-/.exec(t);
  return m ? Number(m[1]) : undefined;
};
export const claims = (e, p) => (e.claims?.[p] ?? []).filter((c) => c.rank !== 'deprecated');
export const ids = (e, p) => claims(e, p).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);

// A house's country, and the states that were part of it or succeeded it, as Wikidata may file them.
const SUCCESSORS = {
  'Soviet Union': ['Russia', 'Ukraine', 'Belarus', 'Moldova', 'Estonia', 'Latvia', 'Lithuania', 'Georgia', 'Armenia', 'Azerbaijan', 'Kazakhstan', 'Uzbekistan', 'Turkmenistan', 'Kyrgyzstan', 'Tajikistan', 'Russian Empire'],
  Yugoslavia: ['Serbia', 'Croatia', 'Slovenia', 'Bosnia and Herzegovina', 'Montenegro', 'North Macedonia', 'Kosovo', 'Kingdom of Yugoslavia', 'Socialist Federal Republic of Yugoslavia', 'Serbia and Montenegro'],
  Czechoslovakia: ['Czech Republic', 'Czechia', 'Slovakia'],
  'East Germany': ['Germany'], 'West Germany': ['Germany'], Germany: ['East Germany', 'West Germany', 'German Reich', 'Weimar Republic'],
  'United Kingdom': ['England', 'Scotland', 'Wales'], 'United States': ['Puerto Rico'],
  'South Yemen': ['Yemen'], 'North Korea': ['Korea'], 'South Korea': ['Korea'], Vietnam: ['North Vietnam', 'South Vietnam'],
  Congo: ['Republic of the Congo'], 'Guinea-Bissau': ['Cape Verde'],
};
// Kinds of organisation a house's entity may be (Wikidata "instance of", P31).
const ORGANISATIONS = new Set([
  'Q2085381', 'Q1320047', 'Q479716', 'Q3972943', // publisher, book publisher, university press, publishing company
  'Q11032', 'Q1110794', 'Q1002697', 'Q41298', 'Q1153191', // newspaper, daily, periodical, magazine, online newspaper
  'Q7278', 'Q1393724', 'Q7210356', 'Q49773', 'Q2659904', 'Q327333', // party, communist party, political organisation, social movement, government organisation, agency
  'Q43229', 'Q4830453', 'Q783794', 'Q6881511', 'Q270791', 'Q163740', 'Q15911314', 'Q1664720', 'Q4287745', // organisation, business, company, enterprise, state-owned enterprise, non-profit, association, institute, medical
  'Q200764', 'Q1137809', 'Q4539', 'Q891723', 'Q5225895', // bookshop, cooperative, cooperative (alt.), public company, cooperative society
]);
// Entities that match a house's name but are another house: Messidor's predecessor, Éditeurs français réunis.
// Found on review of scripts/link-publishers.mjs: a party named Kyrgyzstan, a Kazakh magazine
// called Mysl, a Zagreb eye hospital called Svjetlost, the Vpered faction, the magazine Sovremennik,
// the newspaper Lao Động, and the St Petersburg Prosveshchenie of 1896–1922.
const WRONG = new Set(['Q23946115', 'Q21707885', 'Q12554729', 'Q137943755', 'Q4150673', 'Q1187775', 'Q10784412', 'Q4380954']);
const countryLabels = new Map();
async function countryName(qid) {
  if (!countryLabels.has(qid)) countryLabels.set(qid, (await entity(qid))?.labels?.en?.value ?? qid);
  return countryLabels.get(qid);
}

/** The house's Wikidata entity: the first search result whose names include the house's and whose country is the house's. */
export async function findEntity(p) {
  const names = [p.name, ...(p.alternate_names ?? [])].filter((n) => n.length > 2);
  const wanted = new Set(names.map(plain));
  const countries = new Set([p.country, ...(SUCCESSORS[p.country] ?? []), p.region].filter(Boolean));
  const seen = new Set();
  for (const name of names.slice(0, 4)) {
    for (const lang of ['en', 'mul']) {
      for (const hit of await search(name, lang)) {
        if (seen.has(hit.id)) continue;
        seen.add(hit.id);
        const e = await entity(hit.id);
        if (!e) continue;
        const labels = [...Object.values(e.labels ?? {}), ...Object.values(e.aliases ?? {}).flat()].map((l) => plain(l.value));
        if (!labels.some((l) => wanted.has(l))) continue;
        // Only an organisation: a publisher, newspaper, party, company or the like — not a person,
        // a book or song of the same name ("La Città del Sole", "Le Temps des cerises") or a concept.
        if (!ids(e, 'P31').some((c) => ORGANISATIONS.has(c))) continue;
        const where = await Promise.all(ids(e, 'P17').map(countryName));
        // Its country must be on record and be the house's: same-named journals abroad are not the house.
        if (WRONG.has(e.id) || !where.some((c) => countries.has(c))) continue;
        return e;
      }
    }
  }
  return undefined;
}

/**
 * The identifiers of an item that the site links to (identifiers in src/lib/schemas.ts): the item,
 * and its records in VIAF, the Library of Congress, the GND, ISNI and the BnF, each in the form
 * the site's schema accepts.
 */
const IDENTIFIERS = {
  viaf: ['P214', /^\d+$/], lcnaf: ['P244', /^[a-z]{1,3}\d+$/], gnd: ['P227', /^[\dX-]+$/],
  isni: ['P213', /^\d{15}[\dX]$/], bnf: ['P268', /^\d{8}[0-9bcdfghjkmnpqrstvwxz]$/],
};
export function identifiersOf(qid, e) {
  const found = { wikidata: qid };
  for (const [name, [p, form]] of Object.entries(IDENTIFIERS)) {
    const list = claims(e, p);
    const v = (list.find((c) => c.rank === 'preferred') ?? list[0])?.mainsnak?.datavalue?.value;
    const id = typeof v === 'string' ? v.replace(/\s+/g, '') : undefined;
    if (id && form.test(id)) found[name] = id;
  }
  return found;
}

/** An entity's identifiers as a YAML block in a data file, replacing any there is, else before `before`. */
export function withIdentifiers(text, found, before = 'description') {
  const block = `identifiers:\n${Object.entries(found).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join('\n')}\n`;
  const existing = /^identifiers:[ \t]*\n(?:[ \t]+\S.*\n)+/m;
  if (existing.test(text)) return text.replace(existing, block);
  const at = new RegExp(`^${before}:`, 'm');
  return at.test(text) ? text.replace(at, `${block}${before}:`) : `${text.replace(/\n*$/, '\n')}${block}`;
}
