#!/usr/bin/env node
/**
 * Fills in the years of activity of publishing houses that have none on file.
 *
 * For each house without a founding year (or, when defunct, without a closing year), it looks the
 * house up on Wikidata and takes its documented inception (P571) and dissolution (P576), citing the
 * Wikidata entry. An entity counts only if one of its labels or aliases is one of the house's names
 * and its country is the house's (or a state that was part of it, or succeeded it). Where Wikidata
 * gives nothing, the year is estimated from the house's catalogue (its earliest and, for a defunct
 * house, its latest title) and marked as estimated, so the site shows it as "c. 1975".
 *
 * Disagreements are reported, never applied: a documented founding later than the house's earliest
 * title (a different entity, or a successor), or a dissolution for a house on file as active.
 *
 *   node scripts/check-publisher-years.mjs           report only (reports/publisher-years.md)
 *   node scripts/check-publisher-years.mjs --write   also write the years to data/publishers
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const PUBLISHERS = join(ROOT, 'data', 'publishers');
const CATALOGUES = join(ROOT, 'data', 'catalogues');
const CACHE = join(ROOT, '.cache', 'wikidata');
const write = process.argv.includes('--write');
mkdirSync(CACHE, { recursive: true });

let last = 0;
async function getJson(url) {
  const file = join(CACHE, createHash('sha1').update(url).digest('hex') + '.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  let res;
  for (let attempt = 1; ; attempt++) {
    const wait = last + 2000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    res = await fetch(url, { headers: { 'User-Agent': 'LeftBacklist/1.0 (bibliographic research; publisher years)' }, signal: AbortSignal.timeout(60_000) });
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
const entity = async (qid) => (await getJson(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`)).entities[qid];
const search = async (q, lang) =>
  (await getJson(`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&type=item&limit=7&language=${lang}&search=${encodeURIComponent(q)}`)).search ?? [];

const plain = (s) => String(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const yearOfTime = (claim) => {
  const t = claim?.mainsnak?.datavalue?.value?.time;
  const m = t && /^[+]?(\d{4})-/.exec(t);
  return m ? Number(m[1]) : undefined;
};
const claims = (e, p) => (e.claims?.[p] ?? []).filter((c) => c.rank !== 'deprecated');
const ids = (e, p) => claims(e, p).map((c) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);

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
const WRONG = new Set(['Q23946115']);
const countryLabels = new Map();
async function countryName(qid) {
  if (!countryLabels.has(qid)) countryLabels.set(qid, (await entity(qid))?.labels?.en?.value ?? qid);
  return countryLabels.get(qid);
}

/** The catalogue's span for a house: its earliest and latest dated titles. */
function catalogueYears(id) {
  const dir = join(CATALOGUES, id);
  if (!existsSync(dir)) return {};
  const years = [];
  for (const f of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
    for (const t of yaml.load(readFileSync(join(dir, f), 'utf8'))?.titles ?? []) if (t.year) years.push(t.year);
  }
  if (!years.length) return {};
  years.sort((a, b) => a - b);
  return { first: years[0], last: years.at(-1), count: years.length };
}

/** The house's Wikidata entity: the first search result whose names include the house's and whose country is the house's. */
async function findEntity(p) {
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

/** Writes years into a publisher file, keeping its layout: founded and dissolved before status, estimated after it. */
function writeYears(file, { founded, dissolved, estimated, source }) {
  let text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith('status:'));
  if (at < 0) throw new Error(`no status in ${file}`);
  const add = [];
  if (founded != null && !lines.some((l) => l.startsWith('founded:'))) add.push(`founded: ${founded}`);
  if (dissolved != null && !lines.some((l) => l.startsWith('dissolved:'))) add.push(`dissolved: ${dissolved}`);
  lines.splice(at, 0, ...add);
  if (estimated.length) {
    const e = lines.findIndex((l) => l.startsWith('estimated:'));
    if (e >= 0) {
      let end = e + 1;
      while (lines[end]?.startsWith('  - ')) end++;
      const have = lines.slice(e + 1, end).map((l) => l.slice(4).trim());
      lines.splice(end, 0, ...estimated.filter((x) => !have.includes(x)).map((x) => `  - ${x}`));
    } else {
      const s = lines.findIndex((l) => l.startsWith('status:'));
      lines.splice(s + 1, 0, 'estimated:', ...estimated.map((x) => `  - ${x}`));
    }
  }
  text = lines.join('\n');
  if (source && !text.includes(source.url)) {
    const entry = `  - title: ${JSON.stringify(source.title)}\n    url: ${source.url}`;
    text = /^sources:\s*$/m.test(text) ? text.replace(/^sources:\s*\n/m, `sources:\n${entry}\n`) : `${text.trimEnd()}\nsources:\n${entry}\n`;
  }
  writeFileSync(file, text);
}

const rows = [];
const conflicts = [];
for (const f of readdirSync(PUBLISHERS).filter((f) => f.endsWith('.yaml')).sort()) {
  const id = f.slice(0, -5);
  const p = yaml.load(readFileSync(join(PUBLISHERS, f), 'utf8'));
  const needFounded = p.founded == null;
  const needDissolved = p.status === 'defunct' && p.dissolved == null;
  if (!needFounded && !needDissolved) continue;
  const span = catalogueYears(id);
  const e = await findEntity(p);
  const wdFounded = e && Math.min(...claims(e, 'P571').map(yearOfTime).filter(Boolean));
  const wdDissolved = e && Math.max(...claims(e, 'P576').map(yearOfTime).filter(Boolean));
  const qid = e?.id;
  const result = { id, name: p.name, qid, span, founded: undefined, dissolved: undefined, estimated: [], note: [] };

  if (needFounded) {
    if (Number.isFinite(wdFounded) && (!span.first || wdFounded <= span.first + 1)) result.founded = wdFounded;
    else {
      if (Number.isFinite(wdFounded)) conflicts.push(`${p.name} (${id}): Wikidata ${qid} gives a founding in ${wdFounded}, after its earliest catalogued title (${span.first}); the catalogue's year is used.`);
      if (span.first) { result.founded = span.first; result.estimated.push('founded'); }
    }
  }
  if (needDissolved) {
    if (Number.isFinite(wdDissolved) && (!span.last || wdDissolved >= span.last - 1)) result.dissolved = wdDissolved;
    else {
      if (Number.isFinite(wdDissolved)) conflicts.push(`${p.name} (${id}): Wikidata ${qid} gives a closing in ${wdDissolved}, before its latest catalogued title (${span.last}); the catalogue's year is used.`);
      if (span.last) { result.dissolved = span.last; result.estimated.push('dissolved'); }
    }
  }
  if (p.status === 'active' && Number.isFinite(wdDissolved)) conflicts.push(`${p.name} (${id}): on file as active, but Wikidata ${qid} gives a closing in ${wdDissolved}.`);
  if (p.status === 'defunct' && e && !claims(e, 'P576').length && needDissolved) result.note.push('Wikidata has no closing date: it may still be active');
  rows.push(result);
  const source = qid && ((result.founded != null && !result.estimated.includes('founded')) || (result.dissolved != null && !result.estimated.includes('dissolved')))
    ? { title: `Wikidata — ${e.labels?.en?.value ?? p.name}`, url: `https://www.wikidata.org/wiki/${qid}` } : undefined;
  if (write && (result.founded != null || result.dissolved != null)) writeYears(join(PUBLISHERS, f), { ...result, source });
}

const fmt = (r) => {
  const y = (v, k) => (v == null ? '—' : r.estimated.includes(k) ? `c. ${v}` : String(v));
  return `| ${r.name} | ${y(r.founded, 'founded')} | ${y(r.dissolved, 'dissolved')} | ${r.qid ? `[${r.qid}](https://www.wikidata.org/wiki/${r.qid})` : '—'} | ${r.span.first ?? '—'}–${r.span.last ?? '—'} (${r.span.count ?? 0}) | ${r.note.join('; ')} |`;
};
const documented = rows.filter((r) => (r.founded != null && !r.estimated.includes('founded')) || (r.dissolved != null && !r.estimated.includes('dissolved')));
const report = [
  '# Years of activity',
  '',
  `${rows.length} houses lacked a founding year or (defunct) a closing year. ${documented.length} were found on Wikidata; the rest are estimated from the catalogue.`,
  '',
  '| House | Founded | Closed | Wikidata | Catalogue (titles) | Note |',
  '|---|---|---|---|---|---|',
  ...rows.map(fmt),
  '',
  '## For review',
  '',
  ...(conflicts.length ? conflicts.map((c) => `- ${c}`) : ['None.']),
  '',
].join('\n');
writeFileSync(join(ROOT, 'reports', 'publisher-years.md'), report);
console.log(`${rows.length} houses checked: ${documented.length} with Wikidata years, ${rows.length - documented.length} estimated or left blank; ${conflicts.length} for review. ${write ? 'Written.' : 'Report only (--write to apply).'} See reports/publisher-years.md`);
