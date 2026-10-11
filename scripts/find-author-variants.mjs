#!/usr/bin/env node
/**
 * Finds spellings of each author's name that the catalogue credits but the author's file does not
 * list, so that, say, "Mao Tsé-toung" and "Mao Ce-tung" lead to the same page as "Mao Zedong".
 *
 *   node scripts/find-author-variants.mjs            # dry run: writes reports/author-variants.md
 *   node scripts/find-author-variants.mjs --write    # also adds the variants to alternate_names
 *
 * Spellings come from Wikidata: the labels and aliases of the author's item in every language and
 * script ("Карл Маркс", "കാൾ മാർക്സ്", "マルクス"), and, for names in Cyrillic, Greek, Armenian and
 * Georgian, their initialled forms ("К. Маркс", "Маркс К."). Authors without a Wikidata link are
 * looked up by name, and accepted only when the item's year of birth matches. A spelling is added
 * only when a title in the catalogue credits it, and only when no other author claims it.
 *
 * The item's identifiers are recorded in the author's file too (identifiers: Wikidata, VIAF, the
 * Library of Congress, the GND, ISNI and the BnF), for the site's linked data.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { ROOT } from './lib/openlibrary.mjs';
import { computeNameKey as nameKey } from '../src/lib/name-key.mjs';

const WRITE = process.argv.includes('--write');
const AUTHORS = join(ROOT, 'data', 'authors');
const CATALOGUES = join(ROOT, 'data', 'catalogues');
const CACHE = join(ROOT, '.cache', 'wikidata-names');
mkdirSync(CACHE, { recursive: true });

/**
 * A name's initialled forms, for scripts whose catalogues initial given names ("Карл Маркс" →
 * "К. Маркс", "Маркс К."). Latin-script initials are left to find-author-spellings.mjs, which
 * checks them against the author's own first name.
 */
function initialled(name) {
  if (!/^[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Georgian}\s.-]+$/u.test(name)) return [];
  const words = name.split(/\s+/).filter(Boolean);
  const family = words.at(-1);
  if (words.length < 2 || family.length < 4) return [];
  const initials = words.slice(0, -1).map((w) => `${w[0]}.`).join(' ');
  return [`${initials} ${family}`, `${family} ${initials}`];
}

/** The identifiers of a Wikidata item that the site links to: the item, and its authority records. */
// Each with the form the site's schema accepts (identifiers in src/lib/schemas.ts).
const IDENTIFIERS = {
  viaf: ['P214', /^\d+$/], lcnaf: ['P244', /^[a-z]{1,3}\d+$/], gnd: ['P227', /^[\dX-]+$/],
  isni: ['P213', /^\d{15}[\dX]$/], bnf: ['P268', /^\d{8}[0-9bcdfghjkmnpqrstvwxz]$/],
};
function identifiersOf(qid, e) {
  const ids = { wikidata: qid };
  for (const [name, [p, form]] of Object.entries(IDENTIFIERS)) {
    const claims = (e.claims?.[p] ?? []).filter((c) => c.rank !== 'deprecated');
    const v = (claims.find((c) => c.rank === 'preferred') ?? claims[0])?.mainsnak?.datavalue?.value;
    const id = typeof v === 'string' ? v.replace(/\s+/g, '') : undefined;
    if (id && form.test(id)) ids[name] = id;
  }
  return ids;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url) {
  const file = join(CACHE, createHash('sha1').update(url).digest('hex') + '.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'LeftBacklist/1.0 (bibliographic research)' } });
    if (res.status === 429 || res.status >= 500) { await sleep(1000 * (Number(res.headers.get('retry-after')) || 5 * 2 ** attempt)); continue; }
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const data = await res.json();
    writeFileSync(file, JSON.stringify(data));
    await sleep(500);
    return data;
  }
  throw new Error(`gave up on ${url}`);
}

// Items fetched fifty at a time ahead of the authors' loop (prefetchEntities); others one by one.
const entities = new Map();
const entity = async (qid) => entities.get(qid) ?? (await getJson(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`)).entities[qid];
const batches = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
async function prefetchEntities(qids) {
  for (const batch of batches([...new Set(qids)].filter((q) => !entities.has(q)).sort(), 50)) {
    const r = await getJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels|aliases|claims&ids=${batch.join('|')}`);
    for (const [qid, e] of Object.entries(r.entities ?? {})) if (!e.missing) entities.set(qid, e);
  }
}

// Wikipedia articles' items, looked up fifty titles at a time: "en:Karl Marx" → Q9061.
const WIKIPEDIA = /^https:\/\/([a-z-]+)\.wikipedia\.org\/wiki\/([^#?]+)/;
const articleTitle = (url) => {
  const m = WIKIPEDIA.exec(url ?? '');
  return m ? [m[1], decodeURIComponent(m[2]).replace(/_/g, ' ')] : undefined;
};
const articleItems = new Map();
async function prefetchArticles(articles) {
  const byWiki = new Map();
  for (const [lang, title] of articles) byWiki.set(lang, new Set([...(byWiki.get(lang) ?? []), title]));
  for (const [lang, titles] of byWiki) {
    for (const batch of batches([...titles].sort(), 50)) {
      const r = await getJson(`https://${lang}.wikipedia.org/w/api.php?action=query&format=json&prop=pageprops&ppprop=wikibase_item&redirects=1&titles=${encodeURIComponent(batch.join('|'))}`);
      // A title as asked may come back normalised, then redirected.
      const moved = new Map([...(r.query?.normalized ?? []), ...(r.query?.redirects ?? [])].map((x) => [x.from, x.to]));
      const items = new Map(Object.values(r.query?.pages ?? {}).map((p) => [p.title, p.pageprops?.wikibase_item]));
      for (const title of batch) {
        let t = title;
        for (let i = 0; i < 3 && moved.has(t); i++) t = moved.get(t);
        if (items.get(t)) articleItems.set(`${lang}:${title}`, items.get(t));
      }
    }
  }
}
const birthYear = (e) => {
  const t = e?.claims?.P569?.[0]?.mainsnak?.datavalue?.value?.time;
  return t ? Number(t.slice(1, 5)) : undefined;
};

/**
 * The author's Wikidata item: recorded in their file, linked from their sources (Wikidata, or the
 * Wikipedia article's item), or found by a name search checked against their year of birth.
 */
async function findItem(a) {
  if (a.identifiers?.wikidata) return { qid: a.identifiers.wikidata, how: 'recorded' };
  const linked = JSON.stringify(a.sources ?? []).match(/wikidata\.org\/wiki\/(Q\d+)/)?.[1];
  if (linked) return { qid: linked, how: 'linked' };
  for (const s of a.sources ?? []) {
    const article = articleTitle(s.url);
    const qid = article && articleItems.get(article.join(':'));
    if (qid) return { qid, how: 'wikipedia' };
  }
  if (!a.born) return null;
  for (const query of [a.name, ...(a.alternate_names ?? []).filter((n) => /^[\p{Script=Latin}\s.,'-]+$/u.test(n)).slice(0, 2)]) {
    const r = await getJson(`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&type=item&limit=7&search=${encodeURIComponent(query)}`);
    for (const hit of r.search ?? []) {
      const e = await entity(hit.id);
      if (birthYear(e) === a.born && e.claims?.P31?.some((c) => c.mainsnak?.datavalue?.value?.id === 'Q5')) return { qid: hit.id, how: 'searched' };
    }
  }
  return null;
}

// Every credited name in the catalogue, by normalised key.
const credits = new Map(); // key → Map(spelling → count)
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith('.yaml') ? [join(dir, d.name)] : []));
for (const file of walk(CATALOGUES)) {
  for (const t of yaml.load(readFileSync(file, 'utf8')).titles ?? []) {
    for (const n of [...(t.authors ?? []), ...(t.editors ?? []), ...(t.translators ?? [])]) {
      // "Roman (native)" credits count under each half, as on the site (creditKeys in catalogue.ts).
      const halves = n.match(/^(.+?)\s*\(([^()]+)\)\s*$/);
      for (const part of halves ? [halves[1], halves[2]] : [n]) {
        const k = nameKey(part);
        if (!k) continue;
        const m = credits.get(k) ?? new Map();
        m.set(part, (m.get(part) ?? 0) + 1);
        credits.set(k, m);
      }
    }
  }
}

const authors = readdirSync(AUTHORS).filter((f) => f.endsWith('.yaml')).map((f) => ({ id: f.slice(0, -5), file: join(AUTHORS, f), data: yaml.load(readFileSync(join(AUTHORS, f), 'utf8')) }));
const known = new Map(); // key → author id, for names already listed
for (const a of authors) for (const n of [a.data.name, ...(a.data.alternate_names ?? [])]) known.set(nameKey(n), a.id);

// Wrong or ambiguous aliases found on review: a Wikidata alias of Mayakovsky that names Korolenko,
// a credit that is a journal title, initials too short to identify anyone, other people named in
// pseudonyms' items (Ernesto Rossi for Angelo Tasca's "A. Rossi", Hans Kippenberger for the
// collective "A. Neuberg"), and names too common to be sure of.
const REJECT = new Set(['vladimir galaktionovich korolenko', 'communia', 'c b', 'ernesto rossi', 'hans kippenberger',
  'antonio garcia', 'adolf hoffmann', 'x y z'].map((n) => nameKey(n)));
const latinWords = (s) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
/**
 * Latin-script spellings too loose to trust: an initialled name whose surname does not begin as
 * the author's does ("J. Schneider" for Bedřich Václavek), and given name and patronymic alone
 * ("Aleksandr Ivanovich").
 */
function tooLoose(spelling, author) {
  if (!/^[\p{Script=Latin}\s.,'’ʻʿ-]+$/u.test(spelling)) return false;
  if (/^\S+\s+\S+(ovich|evich|ovna|evna|ovič|evič|ovitch)$/i.test(spelling.trim())) return true;
  if (!/^(\p{Lu}\.\s*)+\S+$/u.test(spelling.trim())) return false;
  const surname = latinWords(spelling).at(-1) ?? '';
  // Any word of the author's names will do: "A. Beliaev" begins as "Belyaev" does.
  return !latinWords(author).some((w) => w.slice(0, 3) === surname.slice(0, 3));
}
const found = new Map(); // key → [{ author, spelling, count }]
const unmatched = [];
// Each author's item, then the items themselves, fetched in batches.
await prefetchArticles(authors.flatMap((a) => (a.data.sources ?? []).map((s) => articleTitle(s.url)).filter(Boolean)));
const items = new Map();
let done = 0;
for (const a of authors) {
  const item = await findItem(a.data).catch((err) => (console.warn(`${a.data.name}: ${err.message}`), null));
  if (item) items.set(a.id, item);
  if (++done % 500 === 0) console.log(`items: ${done}/${authors.length}`);
}
await prefetchEntities([...items.values()].map((i) => i.qid));
console.log(`${items.size} of ${authors.length} authors have a Wikidata item; ${entities.size} items fetched`);

for (const a of authors) {
  const item = items.get(a.id);
  if (!item) { unmatched.push(a.data.name); continue; }
  a.qid = item.qid;
  const e = await entity(item.qid).catch(() => null);
  if (!e) { unmatched.push(a.data.name); continue; }
  a.identifiers = identifiersOf(item.qid, e);
  const names = [...Object.values(e.labels ?? {}), ...Object.values(e.aliases ?? {}).flat()].map((v) => v.value);
  const spellings = new Set([...names, ...names.flatMap(initialled)]);
  for (const s of spellings) {
    const k = nameKey(s);
    // Single words are too ambiguous unless long ("Lenin" yes, "Mao" no).
    // A bare Latin-script surname ("Castro", "Kautsky") may be a relative or namesake.
    if (!k || known.has(k) || REJECT.has(k) || (!k.includes(' ') && /^[a-z]+$/.test(k))) continue;
    if (tooLoose(s, [a.data.name, ...(a.data.alternate_names ?? [])].join(' '))) continue;
    const credited = credits.get(k);
    if (!credited) continue;
    for (const [spelling, count] of credited) {
      const list = found.get(k) ?? [];
      list.push({ author: a, spelling, count });
      found.set(k, list);
    }
  }
}

// Keep spellings claimed by exactly one author.
const additions = new Map(); // author id → [{ spelling, count }]
const conflicts = [];
for (const [k, list] of found) {
  const owners = new Set(list.map((x) => x.author.id));
  if (owners.size > 1) { conflicts.push(`${k}: ${[...owners].join(', ')}`); continue; }
  for (const x of list) {
    const l = additions.get(x.author.id) ?? [];
    if (!l.some((y) => nameKey(y.spelling) === k)) l.push({ spelling: x.spelling, count: list.filter((y) => nameKey(y.spelling) === k).reduce((s, y) => s + y.count, 0) });
    additions.set(x.author.id, l);
  }
}

const lines = ['# Author name variants', '', `Generated by scripts/find-author-variants.mjs. ${[...additions.values()].flat().length} spellings for ${additions.size} authors.`, ''];
for (const a of authors.filter((x) => additions.has(x.id)).sort((x, y) => x.data.name.localeCompare(y.data.name))) {
  const l = additions.get(a.id);
  lines.push(`- **${a.data.name}** (${a.qid}): ${l.map((x) => `${x.spelling} (${x.count})`).join('; ')}`);
}
lines.push('', '## Claimed by more than one author (not added)', '', ...conflicts.map((c) => `- ${c}`));
lines.push('', '## Authors with no Wikidata item found', '', ...unmatched.map((n) => `- ${n}`));
mkdirSync(join(ROOT, 'reports'), { recursive: true });
writeFileSync(join(ROOT, 'reports', 'author-variants.md'), lines.join('\n') + '\n');

/** The author's identifiers as a YAML block, replacing any there is. */
function withIdentifiers(text, ids) {
  const block = `identifiers:\n${Object.entries(ids).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join('\n')}\n`;
  const existing = /^identifiers:[ \t]*\n(?:[ \t]+\S.*\n)+/m;
  if (existing.test(text)) return text.replace(existing, block);
  // Before the description, after the facts about the author.
  return /^description:/m.test(text) ? text.replace(/^description:/m, `${block}description:`) : text + block;
}

if (WRITE) {
  for (const a of authors) {
    if (a.identifiers) writeFileSync(a.file, withIdentifiers(readFileSync(a.file, 'utf8'), a.identifiers));
    const l = additions.get(a.id);
    if (!l) continue;
    let text = readFileSync(a.file, 'utf8');
    const items = l.map((x) => `  - ${JSON.stringify(x.spelling)}`).join('\n');
    if (/^alternate_names:\s*\n(\s+- .*\n)+/m.test(text)) text = text.replace(/^(alternate_names:\s*\n(?:\s+- .*\n)+)/m, `$1${items}\n`);
    // An empty list ("alternate_names: []") is filled in, not repeated.
    else if (/^alternate_names:\s*\[\]\s*$/m.test(text)) text = text.replace(/^alternate_names:\s*\[\]\s*$/m, `alternate_names:\n${items}`);
    else text = text.replace(/^(name: .*\n)/m, `$1alternate_names:\n${items}\n`);
    writeFileSync(a.file, text);
  }
}
console.log(`${[...additions.values()].flat().length} spellings for ${additions.size} authors; ${conflicts.length} conflicts; ${unmatched.length} without an item. See reports/author-variants.md`);
