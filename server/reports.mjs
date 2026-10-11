/**
 * Readers' reports of errors in titles, kept in their own database (var/reports.sqlite by default,
 * REPORTS_DB to move it): the catalogue database is rebuilt and replaced on every deployment, while
 * reports must outlast it. Reports hold what the reader wrote and the title it concerns, nothing
 * about the reader. They are never shown on the site; maintainers read and resolve them with
 * server/reports-cli.mjs, and correct the catalogue's YAML.
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

/** Records a report; returns its id. The caller has checked the title exists. */
export function addReport(db, { href, publisherId, titleId, title, kind, message }) {
  return db.prepare(`INSERT INTO reports (created, href, publisher_id, title_id, title, kind, message) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(new Date().toISOString(), href, publisherId, titleId, title, kind, message).lastInsertRowid;
}
