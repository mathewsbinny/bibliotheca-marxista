// The catalogue database and the API's title queries: a few titles exported as the site build
// exports them, built into a database by scripts/build-db.mjs, then searched as the API searches.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { BadRequest, ftsQuery, parseTitleParams, titleQuery, toRow } from '../server/query.mjs';
import { AUTHOR_TITLES, PUBLISHERS, makeFixture, record } from './fixture.mjs';

let fixture;
let db;
const search = (qs) => {
  const q = titleQuery(parseTitleParams(new URLSearchParams(qs)));
  return {
    titles: db.prepare(q.rows.sql).all(...q.rows.args).map((r) => toRow(r)[1]),
    total: db.prepare(q.count.sql).pluck().get(...q.count.args),
  };
};

before(() => {
  fixture = makeFixture();
  db = new Database(fixture.dbFile, { readonly: true });
});
after(() => {
  db?.close();
  fixture.cleanup();
});

describe('building the database', () => {
  test('holds every exported title', () => {
    assert.equal(db.prepare('SELECT count(*) FROM titles').pluck().get(), 5);
  });

  test('rewrites only the publishers whose exports changed', () => {
    db.close();
    assert.match(fixture.build(), /0 publishers written \(0 titles\), 2 unchanged/);
    const changed = structuredClone(PUBLISHERS);
    changed['international-publishers'].titles.push(record('new-1940', 'A New Title', { year: 1940 }));
    fixture.exportCatalogue(changed, AUTHOR_TITLES);
    assert.match(fixture.build(), /1 publishers written \(3 titles\), 1 unchanged/);
    fixture.exportCatalogue();
    fixture.build();
    db = new Database(fixture.dbFile, { readonly: true });
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
    assert.deepEqual(row, ['/book/progress/state-and-revolution-1970', 'The State and Revolution', '', '', 'V. I. Lenin', '1970', 1970,
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
