// The catalogue database and the API's title queries: a few titles exported as the site build
// exports them, built into a database by scripts/build-db.mjs, then searched as the API searches.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { BadRequest, ftsQuery, parseTitleParams, titleQuery, toRow } from '../server/query.mjs';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const dir = mkdtempSync(join(tmpdir(), 'catalogue-db-'));
const dist = join(dir, 'dist');
const dbFile = join(dir, 'catalogue.sqlite');

const record = (id, title, extra = {}) => ({
  id, title, authors: [], editors: [], translators: [], date: String(extra.year ?? 'n.d.'), places: [], language: 'English',
  links: [], sources: [], verified: false, copyright: [], ...extra,
});
const publishers = {
  progress: { name: 'Progress Publishers', city: 'Moscow', country: 'Soviet Union', titles: [
    record('state-and-revolution-1970', 'The State and Revolution', { year: 1970, authors: [{ name: 'V. I. Lenin', href: '/authors/lenin' }], places: ['Soviet Union'], verified: true }),
    record('capital-1965', 'Capital', { year: 1965, authors: [{ name: 'Karl Marx', href: '/authors/marx' }], links: [{ label: 'Scan (Internet Archive)', url: 'https://archive.org/details/x' }] }),
    record('chudozestvennaja-1975', 'Chudožestvennaja literatura i žizn', { year: 1975, language: 'Russian', places: ['Soviet Union'] }),
  ] },
  'international-publishers': { name: 'International Publishers', city: 'New York', country: 'United States', titles: [
    record('wage-labour-1933', 'Wage-Labour and Capital', { year: 1933, authors: [{ name: 'Karl Marx', href: '/authors/marx' }], places: ['United States'] }),
    record('undated', 'An Undated Pamphlet'),
  ] },
};

/** Writes the build's exports for the publishers given, as `astro build` would. */
function exportCatalogue(pubs, authorTitles) {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(join(dist, 'data', 'db'), { recursive: true });
  const list = Object.entries(pubs).map(([id, p]) => ({ id, name: p.name, city: p.city, country: p.country, titles: p.titles.length, chunks: 1 }));
  writeFileSync(join(dist, 'data', 'catalogue.json'), JSON.stringify({ publishers: list }));
  for (const [id, p] of Object.entries(pubs)) {
    mkdirSync(join(dist, 'data', 'titles', id), { recursive: true });
    writeFileSync(join(dist, 'data', 'titles', id, '0.json'), JSON.stringify(p.titles));
  }
  writeFileSync(join(dist, 'data', 'db', 'author-titles.json'), JSON.stringify(authorTitles));
  writeFileSync(join(dist, 'data', 'db', 'authors.json'), JSON.stringify([{ id: 'marx', name: 'Karl Marx' }, { id: 'lenin', name: 'V. I. Lenin' }]));
}
const build = () =>
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-db.mjs'), '--keep'], {
    env: { ...process.env, CATALOGUE_DIST: dist, CATALOGUE_DB: dbFile }, encoding: 'utf8',
  });
const MARX = { marx: ['/title/?p=progress&t=capital-1965', '/title/?p=international-publishers&t=wage-labour-1933'] };

let db;
const search = (qs) => {
  const q = titleQuery(parseTitleParams(new URLSearchParams(qs)));
  return {
    titles: db.prepare(q.rows.sql).all(...q.rows.args).map((r) => toRow(r)[1]),
    total: db.prepare(q.count.sql).pluck().get(...q.count.args),
  };
};

before(() => {
  exportCatalogue(publishers, MARX);
  build();
  db = new Database(dbFile, { readonly: true });
});
after(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('building the database', () => {
  test('holds every exported title', () => {
    assert.equal(db.prepare('SELECT count(*) FROM titles').pluck().get(), 5);
  });

  test('rewrites only the publishers whose exports changed', () => {
    db.close();
    assert.match(build(), /0 publishers written \(0 titles\), 2 unchanged/);
    const changed = structuredClone(publishers);
    changed['international-publishers'].titles.push(record('new-1940', 'A New Title', { year: 1940 }));
    exportCatalogue(changed, MARX);
    assert.match(build(), /1 publishers written \(3 titles\), 1 unchanged/);
    exportCatalogue(publishers, MARX);
    build();
    db = new Database(dbFile, { readonly: true });
  });
});

describe('title queries', () => {
  test('list in catalogue order (by year, undated last)', () => {
    assert.deepEqual(search('').titles, ['Wage-Labour and Capital', 'Capital', 'The State and Revolution', 'Chudožestvennaja literatura i žizn', 'An Undated Pamphlet']);
  });

  test('match words as prefixes, ignoring accents', () => {
    assert.deepEqual(search('q=chudozestvennaja').titles, ['Chudožestvennaja literatura i žizn']);
    assert.deepEqual(search('q=revol').titles, ['The State and Revolution']);
    assert.equal(search('q=capital').total, 2);
    assert.equal(search('q=lenin state').total, 1, 'every word must match, authors included');
  });

  test('filter by publisher, author, language, place, years, verification and free copies', () => {
    assert.equal(search('pub=progress').total, 3);
    assert.deepEqual(search('author=marx').titles, ['Wage-Labour and Capital', 'Capital']);
    assert.deepEqual(search('lang=Russian').titles, ['Chudožestvennaja literatura i žizn']);
    assert.equal(search('country=Soviet Union').total, 2);
    assert.deepEqual(search('from=1960&to=1971').titles, ['Capital', 'The State and Revolution']);
    assert.deepEqual(search('verified=1').titles, ['The State and Revolution']);
    assert.equal(search('verified=0').total, 4);
    assert.deepEqual(search('free=1').titles, ['Capital']);
  });

  test('sort, with undated titles last both ways', () => {
    assert.equal(search('sort=title').titles[0], 'An Undated Pamphlet');
    assert.equal(search('sort=year-desc').titles[0], 'Chudožestvennaja literatura i žizn');
    assert.equal(search('sort=year-desc').titles.at(-1), 'An Undated Pamphlet');
  });

  test('page with offset and limit', () => {
    assert.deepEqual(search('limit=2&offset=2').titles, ['The State and Revolution', 'Chudožestvennaja literatura i žizn']);
    assert.equal(search('limit=2&offset=2').total, 5);
  });

  test('build rows as the site draws them', () => {
    const q = titleQuery(parseTitleParams(new URLSearchParams('q=state')));
    const row = toRow(db.prepare(q.rows.sql).get(...q.rows.args));
    assert.deepEqual(row, ['/title/?p=progress&t=state-and-revolution-1970', 'The State and Revolution', '', '', 'V. I. Lenin', '1970', 1970,
      'English', 1, 'progress', '', [['V. I. Lenin', 'lenin']]]);
  });
});

describe('checking parameters', () => {
  for (const qs of ['sort=random', 'limit=500', 'offset=-1', 'from=abc', 'verified=yes', 'free=0', 'pub=Bad_Id', 'q=' + 'x'.repeat(201)]) {
    test(`rejects ${qs.slice(0, 30)}`, () => assert.throws(() => parseTitleParams(new URLSearchParams(qs)), BadRequest));
  }

  test('turns a phrase into prefix terms, without FTS syntax', () => {
    assert.equal(ftsQuery('Lenin "state" OR -revolution*'), '"Lenin"* "state"* "OR"* "revolution"*');
    assert.equal(ftsQuery('  ... '), undefined);
  });
});
