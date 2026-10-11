#!/usr/bin/env node
/**
 * Builds the catalogue database (db/catalogue.sqlite) that the API (server/) serves search, the large
 * tables, title records and downloads from, after `astro build`.
 *
 * Its input is what the build exports for it: each publisher's title data files
 * (dist/data/titles/<publisher>/<n>.json, made by the same code as the pages, so ids, author links,
 * places and copyright notes match the site), dist/data/catalogue.json and the author pages'
 * editions (dist/data/db/author-titles.json). Those exports are removed from dist afterwards: the
 * site does not serve them.
 *
 * The build is incremental: a publisher whose exports are unchanged since the last build is left
 * as it is, so an import that touches a few houses rewrites only those.
 *
 *   node scripts/build-db.mjs            update db/catalogue.sqlite from dist
 *   node scripts/build-db.mjs --full     rebuild it from scratch
 *   node scripts/build-db.mjs --keep     leave the exports in dist
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const DIST = process.env.CATALOGUE_DIST ?? join(ROOT, 'dist');
const DB_FILE = process.env.CATALOGUE_DB ?? join(ROOT, 'db', 'catalogue.sqlite');
const full = process.argv.includes('--full');
const started = Date.now();

if (!existsSync(join(DIST, 'data', 'catalogue.json'))) {
  console.error('dist/data/catalogue.json is missing: run `astro build` first.');
  process.exit(1);
}
mkdirSync(join(DB_FILE, '..'), { recursive: true });
if (full) rmSync(DB_FILE, { force: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = OFF');

db.exec(`
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS publishers (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, place TEXT, titles INTEGER NOT NULL, hash TEXT NOT NULL, record TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS titles (
    rowid INTEGER PRIMARY KEY,
    publisher_id TEXT NOT NULL, id TEXT NOT NULL, href TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL, subtitle TEXT, original_title TEXT, series TEXT, notes TEXT, isbn TEXT,
    people TEXT, publisher_name TEXT,
    authors_text TEXT NOT NULL, author_links TEXT NOT NULL,
    date TEXT NOT NULL, year INTEGER, year_sort INTEGER NOT NULL, language TEXT NOT NULL,
    verified INTEGER NOT NULL, free INTEGER NOT NULL,
    sort_title TEXT NOT NULL, sort_author TEXT NOT NULL, sort_publisher TEXT NOT NULL,
    record TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS authors (id TEXT PRIMARY KEY, record TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS titles_by_publisher ON titles (publisher_id, year_sort, sort_title);
  CREATE INDEX IF NOT EXISTS titles_of_publisher ON titles (publisher_id); -- a publisher's titles in row order, for its download
  CREATE INDEX IF NOT EXISTS titles_by_year ON titles (year_sort, sort_title);
  CREATE INDEX IF NOT EXISTS titles_by_title ON titles (sort_title);
  CREATE INDEX IF NOT EXISTS titles_by_author ON titles (sort_author);
  CREATE TABLE IF NOT EXISTS title_lang (lang TEXT NOT NULL, title_rowid INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS title_lang_by_lang ON title_lang (lang, title_rowid);
  CREATE INDEX IF NOT EXISTS title_lang_by_title ON title_lang (title_rowid);
  CREATE TABLE IF NOT EXISTS title_place (place TEXT NOT NULL, title_rowid INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS title_place_by_place ON title_place (place, title_rowid);
  CREATE INDEX IF NOT EXISTS title_place_by_title ON title_place (title_rowid);
  CREATE TABLE IF NOT EXISTS title_author (author_id TEXT NOT NULL, title_rowid INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS title_author_by_author ON title_author (author_id, title_rowid);
  -- Full-text search over the titles' words, without accents ("chudozestvennaja" finds "Chudožestvennaja").
  CREATE VIRTUAL TABLE IF NOT EXISTS titles_fts USING fts5(
    title, subtitle, original_title, people, series, notes, isbn, publisher_name,
    content='titles', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER IF NOT EXISTS titles_fts_insert AFTER INSERT ON titles BEGIN
    INSERT INTO titles_fts (rowid, title, subtitle, original_title, people, series, notes, isbn, publisher_name)
    VALUES (new.rowid, new.title, new.subtitle, new.original_title, new.people, new.series, new.notes, new.isbn, new.publisher_name);
  END;
  CREATE TRIGGER IF NOT EXISTS titles_fts_delete AFTER DELETE ON titles BEGIN
    INSERT INTO titles_fts (titles_fts, rowid, title, subtitle, original_title, people, series, notes, isbn, publisher_name)
    VALUES ('delete', old.rowid, old.title, old.subtitle, old.original_title, old.people, old.series, old.notes, old.isbn, old.publisher_name);
    DELETE FROM title_lang WHERE title_rowid = old.rowid;
    DELETE FROM title_place WHERE title_rowid = old.rowid;
  END;
`);

// Accents and leading quotes or punctuation are ignored; blank values sort last.
const sortText = (s) =>
  s ? s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase() || '￿' : '￿';
const names = (list) => (list.length <= 2 ? list.join(' & ') : `${list.slice(0, -1).join(', ')} & ${list.at(-1)}`);
/** A copy anyone can read without an account (Internet Archive lending copies are not); as isFree in src/lib/catalogue.ts. */
const isFree = (r) => (r.links ?? []).some((l) => !/^Borrow/.test(l.label));
const sha1 = (...parts) => {
  const h = createHash('sha1');
  for (const p of parts) h.update(p);
  return h.digest('hex');
};

const { publishers } = JSON.parse(readFileSync(join(DIST, 'data', 'catalogue.json'), 'utf8'));
const previous = new Map(db.prepare('SELECT id, hash FROM publishers').all().map((p) => [p.id, p.hash]));

const insertTitle = db.prepare(`INSERT INTO titles (publisher_id, id, href, title, subtitle, original_title, series, notes, isbn, people,
  publisher_name, authors_text, author_links, date, year, year_sort, language, verified, free, sort_title, sort_author, sort_publisher, record)
  VALUES (@publisher_id, @id, @href, @title, @subtitle, @original_title, @series, @notes, @isbn, @people, @publisher_name, @authors_text,
  @author_links, @date, @year, @year_sort, @language, @verified, @free, @sort_title, @sort_author, @sort_publisher, @record)`);
const insertLang = db.prepare('INSERT INTO title_lang (lang, title_rowid) VALUES (?, ?)');
const insertPlace = db.prepare('INSERT INTO title_place (place, title_rowid) VALUES (?, ?)');
const deleteTitles = db.prepare('DELETE FROM titles WHERE publisher_id = ?');
const upsertPublisher = db.prepare(`INSERT INTO publishers (id, name, place, titles, hash, record) VALUES (@id, @name, @place, @titles, @hash, @record)
  ON CONFLICT (id) DO UPDATE SET name = excluded.name, place = excluded.place, titles = excluded.titles, hash = excluded.hash, record = excluded.record`);

/** Replaces one publisher's titles with those of its exports. */
const writePublisher = db.transaction((p, files, hash) => {
  deleteTitles.run(p.id);
  const place = p.city ?? p.country ?? '';
  let count = 0;
  for (const text of files) {
    for (const r of JSON.parse(text)) {
      const authorNames = r.authors.map((a) => a.name);
      const links = r.authors.map((a) => [a.name, a.href?.split('/').pop() ?? '']);
      const href = `/title/?p=${encodeURIComponent(p.id)}&t=${encodeURIComponent(r.id)}`;
      const { lastInsertRowid } = insertTitle.run({
        publisher_id: p.id, id: r.id, href,
        title: r.title, subtitle: r.subtitle ?? null, original_title: r.original_title ?? null, series: r.series ?? null,
        notes: r.notes ?? null, isbn: r.isbn ?? null,
        people: [...authorNames, ...(r.editors ?? []), ...(r.translators ?? [])].join(' '),
        publisher_name: p.name,
        authors_text: names(authorNames),
        author_links: JSON.stringify(links.some(([, id]) => id) ? links : []),
        date: r.date, year: r.year ?? null, year_sort: r.year ?? 9999, language: r.language,
        verified: r.verified ? 1 : 0, free: isFree(r) ? 1 : 0,
        sort_title: sortText(r.title), sort_author: sortText(authorNames[0]), sort_publisher: sortText(p.name),
        record: JSON.stringify(r),
      });
      for (const lang of new Set(r.language.split(', '))) insertLang.run(lang, lastInsertRowid);
      for (const place of new Set(r.places ?? [])) insertPlace.run(place, lastInsertRowid);
      count++;
    }
  }
  const { titles: _titles, chunks: _chunks, ...record } = p;
  upsertPublisher.run({ id: p.id, name: p.name, place, titles: count, hash, record: JSON.stringify(record) });
  return count;
});

let changed = 0, unchanged = 0, written = 0;
for (const p of publishers) {
  const dir = join(DIST, 'data', 'titles', p.id);
  const files = Array.from({ length: p.chunks }, (_, n) => readFileSync(join(dir, `${n}.json`), 'utf8'));
  const { titles: _titles, chunks: _chunks, ...data } = p;
  const hash = sha1(JSON.stringify(data), ...files);
  if (previous.get(p.id) === hash) { unchanged++; continue; }
  written += writePublisher(p, files, hash);
  changed++;
}
// Publishers no longer in the catalogue.
const current = new Set(publishers.map((p) => p.id));
const removed = [...previous.keys()].filter((id) => !current.has(id));
db.transaction(() => {
  for (const id of removed) { deleteTitles.run(id); db.prepare('DELETE FROM publishers WHERE id = ?').run(id); }
})();

// The author pages' records, for the download, and their editions: rebuilt whenever a title or the
// authors changed (titles' row ids move when their publisher is rewritten).
const authorRecords = readFileSync(join(DIST, 'data', 'db', 'authors.json'), 'utf8');
const authorFile = readFileSync(join(DIST, 'data', 'db', 'author-titles.json'), 'utf8');
const authorHash = sha1(authorFile, authorRecords);
const lastAuthorHash = db.prepare("SELECT value FROM meta WHERE key = 'authors'").get()?.value;
if (changed || removed.length || authorHash !== lastAuthorHash) {
  const rowidOf = db.prepare('SELECT rowid FROM titles WHERE href = ?').pluck();
  const insertAuthor = db.prepare('INSERT INTO title_author (author_id, title_rowid) VALUES (?, ?)');
  const insertAuthorRecord = db.prepare('INSERT INTO authors (id, record) VALUES (?, ?)');
  db.transaction(() => {
    db.exec('DELETE FROM authors');
    for (const a of JSON.parse(authorRecords)) insertAuthorRecord.run(a.id, JSON.stringify(a));
    db.exec('DELETE FROM title_author');
    for (const [authorId, hrefs] of Object.entries(JSON.parse(authorFile))) {
      for (const href of hrefs) {
        const rowid = rowidOf.get(href);
        if (rowid) insertAuthor.run(authorId, rowid);
      }
    }
    db.prepare("INSERT INTO meta (key, value) VALUES ('authors', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(authorHash);
  })();
}

if (changed || removed.length) {
  db.exec("INSERT INTO titles_fts (titles_fts) VALUES ('optimize')");
  db.exec('ANALYZE');
}
db.prepare("INSERT INTO meta (key, value) VALUES ('built', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(new Date().toISOString());
// One self-contained file to deploy.
db.pragma('wal_checkpoint(TRUNCATE)');
db.pragma('journal_mode = DELETE');
const total = db.prepare('SELECT count(*) FROM titles').pluck().get();
db.close();

if (!process.argv.includes('--keep')) {
  rmSync(join(DIST, 'data', 'titles'), { recursive: true, force: true });
  rmSync(join(DIST, 'data', 'db'), { recursive: true, force: true });
}
console.log(`Catalogue database: ${changed} publishers written (${written} titles), ${unchanged} unchanged, ${removed.length} removed; `
  + `${total} titles in all, in ${Math.round((Date.now() - started) / 1000)} s (${DB_FILE})`);
