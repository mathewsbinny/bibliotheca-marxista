#!/usr/bin/env node
/**
 * Finds spellings of each author's name that the catalogue credits but the author's file does not
 * list, so that, say, "Mao Tsé-toung" and "Mao Ce-tung" lead to the same page as "Mao Zedong".
 *
 *   node scripts/find-author-variants.mjs            # dry run: writes reports/author-variants.md
 *   node scripts/find-author-variants.mjs --write    # also adds the variants to alternate_names
 *
 * Spellings come from Wikidata: the labels and aliases of the author's item in every language.
 * Authors without a Wikidata link are looked up by name, and accepted only when the item's year
 * of birth matches. A spelling is added only when a title in the catalogue credits it, and only
 * when no other author claims it.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { ROOT } from './lib/openlibrary.mjs';

const WRITE = process.argv.includes('--write');
const AUTHORS = join(ROOT, 'data', 'authors');
const CATALOGUES = join(ROOT, 'data', 'catalogues');
const CACHE = join(ROOT, '.cache', 'wikidata-names');
mkdirSync(CACHE, { recursive: true });

/** Same normalisation as nameKey() in src/lib/catalogue.ts. */
function nameKey(name) {
  let n = String(name).replace(/,?\s*\(?\d{4}\s*-\s*(\d{4})?\)?\.?/g, '').trim();
  const parts = n.split(/\s*,\s*/);
  if (parts.length === 2) n = `${parts[1]} ${parts[0]}`;
  return n.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url) {
  const file = join(CACHE, createHash('sha1').update(url).digest('hex') + '.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  for (let attempt = 0; attempt < 6; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'LeftBacklist/1.0 (bibliographic research; author name variants)' } });
    if (res.status === 429 || res.status >= 500) { await sleep(1000 * (Number(res.headers.get('retry-after')) || 5 * 2 ** attempt)); continue; }
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const data = await res.json();
    writeFileSync(file, JSON.stringify(data));
    await sleep(500);
    return data;
  }
  throw new Error(`gave up on ${url}`);
}

const entity = async (qid) => (await getJson(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`)).entities[qid];
const birthYear = (e) => {
  const t = e?.claims?.P569?.[0]?.mainsnak?.datavalue?.value?.time;
  return t ? Number(t.slice(1, 5)) : undefined;
};

/** The author's Wikidata item: from their sources, or by a name search checked against their year of birth. */
async function findItem(a) {
  const linked = JSON.stringify(a.sources ?? []).match(/wikidata\.org\/wiki\/(Q\d+)/)?.[1];
  if (linked) return { qid: linked, how: 'linked' };
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
// a credit that is a journal title, and initials too short to identify anyone.
const REJECT = new Set(['vladimir galaktionovich korolenko', 'communia', 'c b']);
const found = new Map(); // key → [{ author, spelling, count }]
const unmatched = [];
let done = 0;
for (const a of authors) {
  const item = await findItem(a.data).catch((err) => (console.warn(`${a.data.name}: ${err.message}`), null));
  if (++done % 25 === 0) console.log(`${done}/${authors.length}`);
  if (!item) { unmatched.push(a.data.name); continue; }
  a.qid = item.qid;
  const e = await entity(item.qid).catch(() => null);
  if (!e) { unmatched.push(a.data.name); continue; }
  const spellings = new Set([...Object.values(e.labels ?? {}), ...Object.values(e.aliases ?? {}).flat()].map((v) => v.value));
  for (const s of spellings) {
    const k = nameKey(s);
    // Single words are too ambiguous unless long ("Lenin" yes, "Mao" no).
    // A bare Latin-script surname ("Castro", "Kautsky") may be a relative or namesake.
    if (!k || known.has(k) || REJECT.has(k) || (!k.includes(' ') && /^[a-z]+$/.test(k))) continue;
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

if (WRITE) {
  for (const a of authors) {
    const l = additions.get(a.id);
    if (!l) continue;
    let text = readFileSync(a.file, 'utf8');
    const items = l.map((x) => `  - ${JSON.stringify(x.spelling)}`).join('\n');
    if (/^alternate_names:\s*\n(\s+- .*\n)+/m.test(text)) text = text.replace(/^(alternate_names:\s*\n(?:\s+- .*\n)+)/m, `$1${items}\n`);
    else text = text.replace(/^(name: .*\n)/m, `$1alternate_names:\n${items}\n`);
    writeFileSync(a.file, text);
  }
}
console.log(`${[...additions.values()].flat().length} spellings for ${additions.size} authors; ${conflicts.length} conflicts; ${unmatched.length} without an item. See reports/author-variants.md`);
