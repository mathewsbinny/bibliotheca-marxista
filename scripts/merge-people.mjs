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
  for (const t of base.titles) {
    const n = fresh.get(key(t));
    if (!n) { totals.missingNew++; continue; }
    fresh.delete(key(t));
    if (!t.original_title && n.original_title) { t.original_title = n.original_title; totals.original++; changed = true; }
    if (!t.translators?.length && n.translators?.length) {
      t.translators = n.translators;
      t.authors = (t.authors ?? []).filter((a) => !n.translators.includes(a));
      totals.translators++;
      changed = true;
    }
    if (!t.editors?.length && n.editors?.length) { t.editors = n.editors.filter((e) => !(t.authors ?? []).includes(e)); if (t.editors.length) { totals.editors++; changed = true; } else delete t.editors; }
  }
  totals.unmatchedNew += fresh.size;
  totals.files++;
  if (!changed) continue;
  totals.titles += base.titles.length;
  // The fields in the order the importer writes them.
  const ORDER = ['id', 'title', 'subtitle', 'original_title', 'authors', 'editors', 'translators'];
  base.titles = base.titles.map((t) => Object.fromEntries([...ORDER.filter((k) => k in t).map((k) => [k, t[k]]), ...Object.entries(t).filter(([k]) => !ORDER.includes(k))]));
  if (WRITE) writeFileSync(join(ROOT, rel), header + yaml.dump(base, { lineWidth: -1, noRefs: true }));
}
console.log(totals);
if (!WRITE) console.log('Dry run: nothing written. With --write, the merged files replace the imported ones.');
