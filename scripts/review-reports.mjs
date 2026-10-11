#!/usr/bin/env node
/**
 * Reviews readers' open error reports (server/reports.mjs). A report whose correction is plain is
 * written to data/corrections/<publisher>.yaml and marked "applied"; any other is marked "manual",
 * with the reason, for a maintainer (scripts/lib/report-review.mjs has the rules). Corrections are
 * meant to be read before they are committed: in the GitHub workflow they arrive as a pull request.
 *
 *   node scripts/review-reports.mjs                   the reports in var/reports.sqlite (REPORTS_DB),
 *                                                     with db/catalogue.sqlite (CATALOGUE_DB)
 *   node scripts/review-reports.mjs --from=open.json  reports exported on the server
 *                                                     (server/reports-cli.mjs export); the decisions go
 *                                                     to --decisions=<file>, for reports-cli.mjs import
 *   --summary=<file>   where to write the summary (default reports/report-review.md)
 *   --corrections=<dir>  where the corrections go (default data/corrections)
 *   --dry-run          decide, but write nothing
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import * as yaml from 'js-yaml';
import { KINDS, decideReport, defaultReportsFile, openReports, reportsForReview } from '../server/reports.mjs';
import { decide } from './lib/report-review.mjs';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)).map(([k, v]) => [k, v ?? true]));
const dryRun = !!args['dry-run'];

let reports, reportsDb;
if (args.from) {
  reports = JSON.parse(readFileSync(args.from, 'utf8'));
} else {
  reportsDb = openReports(defaultReportsFile(ROOT));
  const catalogue = new Database(process.env.CATALOGUE_DB ?? join(ROOT, 'db', 'catalogue.sqlite'), { readonly: true, fileMustExist: true });
  reports = reportsForReview(reportsDb, catalogue);
}

const decisions = reports.map((report) => ({ report, ...decide(report) }));
const applied = decisions.filter((d) => d.action === 'apply');
const manual = decisions.filter((d) => d.action === 'manual');

// The corrections, added to each publisher's file.
const byPublisher = new Map();
for (const d of applied) {
  const list = byPublisher.get(d.report.record.publisherId) ?? [];
  list.push({ id: d.id ?? d.report.record.id, report: d.report.id, note: `Reader report #${d.report.id}: ${d.summary}`,
    ...(d.remove ? { remove: true } : { set: d.set }) });
  byPublisher.set(d.report.record.publisherId, list);
}
if (!dryRun) {
  for (const [publisher, list] of byPublisher) {
    const file = join(args.corrections ?? join(ROOT, 'data', 'corrections'), `${publisher}.yaml`);
    const existing = existsSync(file) ? yaml.load(readFileSync(file, 'utf8')).corrections : [];
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `# Corrections to ${publisher}'s titles, applied over data/catalogues/ (see src/lib/schemas.ts, "correction").\n`
      + yaml.dump({ publisher, corrections: [...existing, ...list] }, { lineWidth: -1, noRefs: true }));
  }
}

// The decisions: recorded in the reports database, or written out for the server's.
const outcome = decisions.map((d) => ({ id: d.report.id, status: d.action === 'apply' ? 'applied' : 'manual',
  note: d.action === 'apply' ? `Correction written: ${d.summary}` : `Manual review: ${d.reason}` }));
if (!dryRun) {
  if (reportsDb) for (const o of outcome) decideReport(reportsDb, o.id, o.status, o.note);
  else if (args.decisions) writeFileSync(args.decisions, JSON.stringify(outcome, null, 2));
}

// The summary, for the maintainer (and the pull request's description). Readers' text is shown as
// code, so nothing in it is read as markup or mentions anyone.
const quote = (text) => (text ? `\n\n  \`\`\`text\n  ${String(text).replace(/`/g, 'ʼ').replace(/\n/g, '\n  ')}\n  \`\`\`` : ' (no message)');
const md = (text) => String(text).replace(/[\\`*_[\]<>#@|~]/g, '\\$&');
const line = (d) => `- **#${d.report.id}** ${KINDS[d.report.kind] ?? d.report.kind}: [${md(d.report.title)}](${d.report.href})`
  + ` — ${md(d.action === 'apply' ? d.summary : d.reason)}${quote(d.report.message)}`;
const summary = `# Readers' error reports\n\n${reports.length} open reports: ${applied.length} corrected, ${manual.length} left for manual review.\n`
  + (applied.length ? `\n## Corrected (data/corrections/)\n\nCheck each against the library records before merging.\n\n${applied.map(line).join('\n')}\n` : '')
  + (manual.length ? `\n## For manual review\n\nSee them with \`node server/reports-cli.mjs\`.\n\n${manual.map(line).join('\n')}\n` : '');
const summaryFile = args.summary ?? join(ROOT, 'reports', 'report-review.md');
if (!dryRun) {
  mkdirSync(dirname(summaryFile), { recursive: true });
  writeFileSync(summaryFile, summary);
}
console.log(`${reports.length} open reports: ${applied.length} corrected, ${manual.length} for manual review.${dryRun ? ' (dry run: nothing written)' : ` Summary: ${summaryFile}`}`);
