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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { claims, findEntity, yearOfTime } from './lib/wikidata.mjs';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const PUBLISHERS = join(ROOT, 'data', 'publishers');
const CATALOGUES = join(ROOT, 'data', 'catalogues');
const write = process.argv.includes('--write');

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
