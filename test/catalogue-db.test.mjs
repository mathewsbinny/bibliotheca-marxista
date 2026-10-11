// The catalogue database and the API's title queries: a few titles exported as the site build
// exports them, built into a database by scripts/build-db.mjs, then searched as the API searches.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { BadRequest, facetQueries, ftsQuery, parseTitleParams, seriesName, suggestQuery, titleQuery, toRow } from '../server/query.mjs';
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

describe('series', () => {
  test("a series' name leaves out the volume and its editors", () => {
    assert.equal(seriesName('Little Lenin Library -- v. 15'), 'Little Lenin Library');
    assert.equal(seriesName('Kompassbücherei; 122'), 'Kompassbücherei');
    assert.equal(seriesName('現代哲学全書, 17'), '現代哲学全書');
    assert.equal(seriesName('Raskršća / Midhat Begić; Knj. 3'), 'Raskršća');
    assert.equal(seriesName('Rozpravy Československé Akademie Věd; Ročník 73, Sešit 5'), 'Rozpravy Československé Akademie Věd');
    assert.equal(seriesName('Naša rodina, geografičeskaja serija'), 'Naša rodina, geografičeskaja serija', 'a part without a number is kept');
  });
  test('finds every volume of a series', () => {
    assert.deepEqual(search('series=Little Marx Library').titles, ['Wage-Labour and Capital', 'Capital']);
  });
});

describe('facets', () => {
  const facets = (qs) => Object.fromEntries(Object.entries(facetQueries(parseTitleParams(new URLSearchParams(qs))))
    .map(([name, q]) => [name, db.prepare(q.sql).all(...q.args).map((r) => [r.value, r.n])]));
  test('count the titles found by language, country, publisher and decade', () => {
    const f = facets('q=capital');
    assert.deepEqual(f.lang, [['English', 2]]);
    assert.deepEqual(f.decade, [[1930, 1], [1960, 1]]);
    assert.deepEqual(f.pub.map(([p]) => p).sort(), ['international-publishers', 'progress']);
  });
  test("each leaves out its own filter, so its other values stay in view", () => {
    const f = facets('pub=progress&lang=Russian');
    assert.deepEqual(f.pub, [['progress', 1]], 'the language still narrows the publishers');
    assert.deepEqual(f.lang.sort(), [['English', 2], ['Russian', 1]], 'but not the languages');
  });
  test("the whole catalogue's are counted when the database is built", () => {
    const stored = JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'facets'").pluck().get());
    assert.deepEqual(stored, facets(''));
  });
});

describe('suggestions', () => {
  const suggest = (q) => {
    const s = suggestQuery(q);
    return s ? db.prepare(s.sql).all(...s.args).map((r) => `${r.kind}: ${r.label}`) : [];
  };
  test('authors, publishers and series, found from any word of their names', () => {
    assert.deepEqual(suggest('marx'), ['author: Karl Marx', 'series: Little Marx Library']);
    assert.deepEqual(suggest('lenin'), ['author: V. I. Lenin']);
    assert.deepEqual(suggest('PROGR'), ['publisher: Progress Publishers']);
    assert.deepEqual(suggest('little marx'), ['series: Little Marx Library'], 'words in order');
  });
  test('nothing for a single letter', () => assert.deepEqual(suggest('m'), []));
});
