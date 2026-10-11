#!/usr/bin/env node
/**
 * Readers' error reports (server/reports.mjs), for maintainers.
 *
 *   node server/reports-cli.mjs                     the reports needing attention (open and manual), newest first
 *   node server/reports-cli.mjs --all               every report
 *   node server/reports-cli.mjs resolve 12 [note]   mark report 12 resolved (once the YAML is corrected)
 *   node server/reports-cli.mjs dismiss 12 [note]   mark report 12 dismissed (not an error)
 *   node server/reports-cli.mjs reopen 12
 *   node server/reports-cli.mjs export              the open reports with their titles' records, as JSON,
 *                                                   for scripts/review-reports.mjs (needs CATALOGUE_DB)
 *   node server/reports-cli.mjs import < file.json  record that script's decisions ([{id, status, note}])
 *
 * On the server: docker exec bibliotheca-api node server/reports-cli.mjs
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { KINDS, decideReport, defaultReportsFile, openReports, reportsForReview } from './reports.mjs';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const db = openReports(defaultReportsFile(ROOT));
const [command, id, ...noteWords] = process.argv.slice(2);

if (['resolve', 'dismiss', 'reopen'].includes(command)) {
  const status = { resolve: 'resolved', dismiss: 'dismissed', reopen: 'open' }[command];
  const { changes } = db.prepare('UPDATE reports SET status = ?, resolved = ?, note = COALESCE(?, note) WHERE id = ?')
    .run(status, status === 'open' ? null : new Date().toISOString(), noteWords.join(' ') || null, Number(id));
  console.log(changes ? `Report ${id}: ${status}.` : `No report ${id}.`);
} else if (command === 'export') {
  const catalogue = new Database(process.env.CATALOGUE_DB ?? join(ROOT, 'db', 'catalogue.sqlite'), { readonly: true, fileMustExist: true });
  process.stdout.write(JSON.stringify(reportsForReview(db, catalogue)));
} else if (command === 'import') {
  const decisions = JSON.parse(readFileSync(id ?? 0, 'utf8'));
  let changed = 0;
  for (const d of decisions) changed += decideReport(db, Number(d.id), d.status, d.note);
  console.log(`${changed} of ${decisions.length} reports updated (the others were no longer open).`);
} else {
  const all = command === '--all';
  const rows = db.prepare(`SELECT * FROM reports ${all ? '' : "WHERE status IN ('open', 'manual')"} ORDER BY created DESC`).all();
  const counts = db.prepare('SELECT status, count(*) AS n FROM reports GROUP BY status').all().map((r) => `${r.n} ${r.status}`).join(', ');
  console.log(`${rows.length} ${all ? '' : 'open or manual '}reports${counts ? ` (${counts})` : ''}\n`);
  for (const r of rows) {
    console.log(`#${r.id}  ${r.created.slice(0, 16).replace('T', ' ')}  [${r.status}]  ${KINDS[r.kind] ?? r.kind}`);
    console.log(`    ${r.title} — ${r.href}  (data/catalogues/${r.publisher_id}/, id ${r.title_id})`);
    if (r.message) console.log(`    “${r.message.replace(/\s+/g, ' ')}”`);
    if (r.note) console.log(`    note: ${r.note}`);
  }
}
