/**
 * Readers' reports of errors in titles, kept in their own database (var/reports.sqlite by default,
 * REPORTS_DB to move it): the catalogue database is rebuilt and replaced on every deployment, while
 * reports must outlast it. Reports hold what the reader wrote and the title it concerns, nothing
 * about the reader. They are never shown on the site. scripts/review-reports.mjs turns the plain
 * ones into corrections (data/corrections/); maintainers read the rest with server/reports-cli.mjs.
 */
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';

/** What can be wrong with a title, as the report form offers it. */
export const KINDS = {
  title: 'Wrong title or subtitle',
  author: 'Wrong or missing author',
  date: 'Wrong year or date',
  publisher: 'Belongs to another publisher',
  language: 'Wrong language',
  duplicate: 'Duplicate of another title',
  scope: 'Not a publication of the Left',
  link: 'Broken or wrong link',
  other: 'Something else',
};
export const MAX_MESSAGE = 2000;

/**
 * A report's status: open (new); applied (scripts/review-reports.mjs wrote its correction, to be
 * reviewed and deployed); manual (left for a maintainer); resolved; dismissed (not an error).
 */
export const STATUSES = ['open', 'applied', 'manual', 'resolved', 'dismissed'];

export function openReports(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY,
    created TEXT NOT NULL,
    href TEXT NOT NULL,
    publisher_id TEXT NOT NULL,
    title_id TEXT NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    resolved TEXT,
    note TEXT
  );
  CREATE INDEX IF NOT EXISTS reports_by_status ON reports (status, created);`);
  return db;
}

export const defaultReportsFile = (root) => process.env.REPORTS_DB ?? join(root, 'var', 'reports.sqlite');

/**
 * The open reports, each with the record of the title it concerns (null if the title is gone) and
 * of any other title its message names by address (`others`), for scripts/review-reports.mjs.
 * `catalogue` is the catalogue database.
 */
export function reportsForReview(db, catalogue) {
  const find = catalogue.prepare('SELECT publisher_id, href, record FROM titles WHERE href = ?');
  const record = (href) => {
    const row = find.get(href);
    return row ? { ...JSON.parse(row.record), href: row.href, publisherId: row.publisher_id } : null;
  };
  return db.prepare("SELECT * FROM reports WHERE status = 'open' ORDER BY id").all().map((r) => {
    const others = {};
    for (const [href] of r.message.matchAll(/\/book\/[a-z0-9-]+\/[\p{L}\p{N}-]+/gu)) if (href !== r.href) others[href] = record(href);
    return { ...r, record: record(r.href), others };
  });
}

/** Records a decision on a report (status and note), if it is still open. */
export function decideReport(db, id, status, note) {
  if (!STATUSES.includes(status)) throw new Error(`unknown status ${status}`);
  return db.prepare("UPDATE reports SET status = ?, resolved = ?, note = ? WHERE id = ? AND status = 'open'")
    .run(status, ['resolved', 'dismissed'].includes(status) ? new Date().toISOString() : null, note ?? null, id).changes;
}

/** Records a report; returns its id. The caller has checked the title exists. */
export function addReport(db, { href, publisherId, titleId, title, kind, message }) {
  return db.prepare(`INSERT INTO reports (created, href, publisher_id, title_id, title, kind, message) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(new Date().toISOString(), href, publisherId, titleId, title, kind, message).lastInsertRowid;
}
