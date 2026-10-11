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
import { facetQueries, seriesName } from '../server/query.mjs';
import { workKey } from '../server/works.mjs';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const DIST = process.env.CATALOGUE_DIST ?? join(ROOT, 'dist');
const DB_FILE = process.env.CATALOGUE_DB ?? join(ROOT, 'db', 'catalogue.sqlite');
const full = process.argv.includes('--full');
/** The version of what is stored for each title: change it when that changes, to rewrite every title. */
const FORMAT = 'series-names-1';
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
    title TEXT NOT NULL, subtitle TEXT, original_title TEXT, series TEXT, series_name TEXT, notes TEXT, isbn TEXT,
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
  -- Suggestions as a reader types: authors, publishers and series, found from any word of their
  -- names ("lenin" finds "V. I. Lenin"); each name is stored once for each word it can be found by.
  CREATE TABLE IF NOT EXISTS suggest (key TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, href TEXT NOT NULL, weight INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS suggest_by_key ON suggest (key);
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

// A database built before titles kept their series' name (FORMAT then rewrites every title).
if (!db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name = ?').get('titles', 'series_name')) db.exec('ALTER TABLE titles ADD COLUMN series_name TEXT');
db.exec('CREATE INDEX IF NOT EXISTS titles_by_series ON titles (series_name, year_sort, sort_title)');

// Accents and leading quotes or punctuation are ignored; blank values sort last.
const sortText = (s) =>
  s ? s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/^[^\p{L}\p{N}]+/u, '').toLowerCase() || '￿' : '￿';
/** A name as suggestions look it up: no accents or punctuation, lower case (as suggestKey in server/query.mjs). */
const suggestKey = (s) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
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

const insertTitle = db.prepare(`INSERT INTO titles (publisher_id, id, href, title, subtitle, original_title, series, series_name, notes, isbn, people,
  publisher_name, authors_text, author_links, date, year, year_sort, language, verified, free, sort_title, sort_author, sort_publisher, record)
  VALUES (@publisher_id, @id, @href, @title, @subtitle, @original_title, @series, @series_name, @notes, @isbn, @people, @publisher_name, @authors_text,
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
      const href = `/book/${encodeURIComponent(p.id)}/${encodeURIComponent(r.id)}`; // as titleHref in src/lib/shard.ts
      const { lastInsertRowid } = insertTitle.run({
        publisher_id: p.id, id: r.id, href,
        title: r.title, subtitle: r.subtitle ?? null, original_title: r.original_title ?? null, series: r.series ?? null, series_name: seriesName(r.series) ?? null,
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
  // FORMAT is part of the fingerprint, so a change to what this script stores (as when titles moved
  // to /book/ addresses) rewrites every publisher, though their exports are the same.
  const hash = sha1(FORMAT, JSON.stringify(data), ...files);
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

// Editions grouped as works (server/works.mjs): rebuilt with the titles, whose row ids move when
// their publisher is rewritten. Only works of two editions or more are kept.
db.exec(`CREATE TABLE IF NOT EXISTS works (id INTEGER PRIMARY KEY, title TEXT NOT NULL, editions INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS title_work (title_rowid INTEGER PRIMARY KEY, work_id INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS title_work_by_work ON title_work (work_id);`);
if (changed || removed.length || !db.prepare('SELECT 1 FROM works LIMIT 1').get()) {
  const groups = new Map(); // key → [{ rowid, title, original }]
  for (const r of db.prepare('SELECT rowid, title, original_title, author_links, authors_text FROM titles').iterate()) {
    const key = workKey(r);
    if (!key) continue;
    const list = groups.get(key);
    const edition = { rowid: r.rowid, title: r.title, original: r.original_title };
    if (list) list.push(edition);
    else groups.set(key, [edition]);
  }
  // A work is called by the title it was written under when an edition gives it, else by its editions' commonest title.
  const commonest = (values) => [...values.reduce((m, v) => m.set(v, (m.get(v) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1])[0]?.[0];
  const insertWork = db.prepare('INSERT INTO works (id, title, editions) VALUES (?, ?, ?)');
  const insertTitleWork = db.prepare('INSERT INTO title_work (title_rowid, work_id) VALUES (?, ?)');
  db.transaction(() => {
    db.exec('DELETE FROM works; DELETE FROM title_work');
    let id = 0;
    for (const editions of groups.values()) {
      if (editions.length < 2) continue;
      insertWork.run(++id, commonest(editions.map((e) => e.original).filter(Boolean)) ?? commonest(editions.map((e) => e.title)), editions.length);
      for (const e of editions) insertTitleWork.run(e.rowid, id);
    }
  })();
}

// The suggestions, rebuilt with the titles or authors they count.
if (changed || removed.length || authorHash !== lastAuthorHash || !db.prepare('SELECT 1 FROM suggest LIMIT 1').get()) {
  const insertSuggest = db.prepare('INSERT INTO suggest (key, kind, label, href, weight) VALUES (?, ?, ?, ?, ?)');
  const add = (kind, label, href, weight, other = []) => {
    const keys = new Set();
    for (const name of [label, ...other]) {
      const words = suggestKey(name).split(' ').filter(Boolean);
      words.forEach((_, i) => keys.add(words.slice(i).join(' ')));
    }
    for (const key of keys) insertSuggest.run(key, kind, label, href, weight);
  };
  const editions = new Map(db.prepare('SELECT author_id, count(*) AS n FROM title_author GROUP BY author_id').all().map((r) => [r.author_id, r.n]));
  db.transaction(() => {
    db.exec('DELETE FROM suggest');
    for (const a of JSON.parse(authorRecords)) add('author', a.name, `/authors/${a.id}`, editions.get(a.id) ?? 0, a.alternate_names ?? []);
    for (const p of db.prepare('SELECT id, name, titles FROM publishers').all()) add('publisher', p.name, `/publishers/${p.id}`, p.titles);
    // Series of two titles or more, which a search of the series lists.
    for (const s of db.prepare('SELECT series_name, count(*) AS n FROM titles WHERE series_name IS NOT NULL GROUP BY series_name HAVING n >= 2').all()) {
      add('series', s.series_name, `/titles?series=${encodeURIComponent(s.series_name)}`, s.n);
    }
  })();
}

// The facets of the whole catalogue (the Titles page before any search), counted once here rather
// than by the API (some seconds over every title).
if (changed || removed.length || !db.prepare("SELECT 1 FROM meta WHERE key = 'facets'").get()) {
  const facets = Object.fromEntries(Object.entries(facetQueries({})).map(([name, q]) => [name, db.prepare(q.sql).all(...q.args).map((r) => [r.value, r.n])]));
  db.prepare("INSERT INTO meta (key, value) VALUES ('facets', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(facets));
}

if (changed || removed.length) {
  db.exec("INSERT INTO titles_fts (titles_fts) VALUES ('optimize')");
  db.exec('ANALYZE');
}
db.prepare("INSERT INTO meta (key, value) VALUES ('built', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(new Date().toISOString());
// The site's title page, which the API fills in for each title's page (server/book.mjs): it carries
// the build's header, footer and stylesheet addresses.
const templateFile = join(DIST, 'title', 'index.html');
if (existsSync(templateFile)) {
  db.prepare("INSERT INTO meta (key, value) VALUES ('book-template', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(readFileSync(templateFile, 'utf8'));
}
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
