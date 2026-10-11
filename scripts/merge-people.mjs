#!/usr/bin/env node
/**
 * Carries the translators, editors and original titles found by a fresh import into the committed
 * catalogue files, and changes nothing else: an import run from the cache alone may miss records
 * whose responses were not cached, and its files cannot simply replace the committed ones.
 *
 * For each house's imported file (data/catalogues/<id>/openlibrary.yaml), the version in git (HEAD)
 * is the base; each of its titles that the new file has too (same title and year) takes the new
 * translators, editors and original title when it has none, and a translator credited as an
 * author is no longer listed as one. The file is then written back as the base, so no title is
 * added, dropped or renamed.
 *
 *   node scripts/merge-people.mjs            report only
 *   node scripts/merge-people.mjs --write    write the merged files
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { ROOT } from './lib/openlibrary.mjs';

const WRITE = process.argv.includes('--write');
const CATALOGUES = join(ROOT, 'data', 'catalogues');
const GENERATED = 'openlibrary.yaml';
const key = (t) => `${String(t.title).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()}|${t.year ?? ''}`;

const totals = { files: 0, titles: 0, translators: 0, editors: 0, original: 0, unmatchedNew: 0, missingNew: 0 };
for (const house of readdirSync(CATALOGUES).sort()) {
  const rel = `data/catalogues/${house}/${GENERATED}`;
  let committed;
  try { committed = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 30 }); } catch { continue; }
  const current = readFileSync(join(ROOT, rel), 'utf8');
  if (current === committed) continue;
  const header = committed.slice(0, committed.indexOf('publisher:'));
  const base = yaml.load(committed);
  const fresh = new Map();
  for (const t of yaml.load(current).titles ?? []) if (!fresh.has(key(t))) fresh.set(key(t), t);
  let changed = false;
  base.titles = base.titles.map((t) => {
    const n = fresh.get(key(t));
    if (!n) { totals.missingNew++; return t; }
    fresh.delete(key(t));
    const add = {};
    if (!t.original_title && n.original_title) { add.original_title = n.original_title; totals.original++; }
    const translators = !t.translators?.length && n.translators?.length ? n.translators : undefined;
    const authors = translators ? (t.authors ?? []).filter((a) => !translators.includes(a)) : t.authors;
    if (translators) { add.translators = translators; totals.translators++; }
    const editors = !t.editors?.length && n.editors?.length ? n.editors.filter((e) => !(authors ?? []).includes(e)) : [];
    if (editors.length) { add.editors = editors; totals.editors++; }
    if (!Object.keys(add).length) return t;
    changed = true;
    // The new fields go where the importer writes them (the original title after the subtitle,
    // the editors and translators after the authors); the others keep their order.
    const out = {};
    for (const [k, v] of Object.entries(t)) {
      if (['original_title', 'editors', 'translators'].includes(k) && k in add) continue;
      out[k] = k === 'authors' ? authors : v;
      if (k === (t.subtitle !== undefined ? 'subtitle' : 'title') && add.original_title) out.original_title = add.original_title;
      if (k === 'authors') {
        if (add.editors) out.editors = add.editors;
        if (add.translators) out.translators = add.translators;
      }
    }
    for (const [k, v] of Object.entries(add)) if (!(k in out)) out[k] = v;
    return out;
  });
  totals.unmatchedNew += fresh.size;
  totals.files++;
  // Nothing new: the committed file goes back as it was, in place of the import's.
  if (!changed) {
    if (WRITE) writeFileSync(join(ROOT, rel), committed);
    continue;
  }
  totals.titles += base.titles.length;
  if (WRITE) writeFileSync(join(ROOT, rel), header + yaml.dump(base, { lineWidth: -1, noRefs: true }));
}
console.log(totals);
if (!WRITE) console.log('Dry run: nothing written. With --write, the merged files replace the imported ones.');
