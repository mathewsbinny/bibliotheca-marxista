// The site's own logic, as the pages and the browser use it: table filters and sorting, and title links.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compareRows, matches } from '../src/lib/filters.ts';
import { chunkCount, chunkOf, titleHref } from '../src/lib/shard.ts';

const criteria = (c = {}) => ({ terms: [], from: -Infinity, to: Infinity, lang: '', pub: '', country: '', verified: '', access: '', sort: '', ...c });
const row = (r = {}) => ({ search: 'the state and revolution lenin', year: 1970, lang: 'English', pub: 'progress', verified: true, free: false, ...r });

describe('filtering a table', () => {
  test('every search word must appear', () => {
    assert.ok(matches(row(), criteria({ terms: ['state', 'lenin'] })));
    assert.ok(!matches(row(), criteria({ terms: ['state', 'marx'] })));
  });

  test('a year range leaves out undated titles', () => {
    assert.ok(matches(row(), criteria({ from: 1960, to: 1975 })));
    assert.ok(!matches(row(), criteria({ from: 1971 })));
    assert.ok(!matches(row({ year: undefined }), criteria({ from: 1900 })));
    assert.ok(matches(row({ year: undefined }), criteria()), 'with no range, undated titles stay');
  });

  test('a title in several languages counts for each', () => {
    assert.ok(matches(row({ lang: 'Russian, English' }), criteria({ lang: 'English' })));
    assert.ok(!matches(row({ lang: 'Russian, English' }), criteria({ lang: 'German' })));
  });

  test('publisher, verification and free copies', () => {
    assert.ok(!matches(row(), criteria({ pub: 'dietz-verlag' })));
    assert.ok(matches(row(), criteria({ verified: '1' })));
    assert.ok(!matches(row(), criteria({ verified: '0' })));
    assert.ok(!matches(row(), criteria({ access: 'free' })));
    assert.ok(matches(row({ free: true }), criteria({ access: 'free' })));
  });
});

describe('sorting a table', () => {
  const a = { title: 'Capital', author: 'Marx', publisher: 'Progress', year: 1965 };
  const b = { title: 'anarchism', author: '', publisher: 'Dietz', year: undefined };
  test('by title, ignoring case', () => assert.ok(compareRows(b, a, 'title') < 0));
  test('blanks and undated titles last, in both directions', () => {
    assert.ok(compareRows(b, a, 'author') > 0);
    assert.ok(compareRows(b, a, 'year') > 0);
    assert.ok(compareRows(b, a, 'year-desc') > 0);
  });
  test('the default keeps catalogue order', () => assert.equal(compareRows(a, b, ''), 0));
});

describe('title links', () => {
  test('encode the publisher and title id', () => {
    assert.equal(titleHref('progress', 'capital-1965'), '/title/?p=progress&t=capital-1965');
    assert.equal(titleHref('nauka-moscow', 'собрание'), '/title/?p=nauka-moscow&t=%D1%81%D0%BE%D0%B1%D1%80%D0%B0%D0%BD%D0%B8%D0%B5');
  });

  test("a title's data file is fixed by its id, and in range", () => {
    assert.equal(chunkCount(0), 1);
    assert.equal(chunkCount(401), 2);
    assert.equal(chunkOf('capital-1965', 7), chunkOf('capital-1965', 7));
    for (const id of ['a', 'capital-1965', 'собрание', 'x'.repeat(200)]) {
      const c = chunkOf(id, 5);
      assert.ok(Number.isInteger(c) && c >= 0 && c < 5);
    }
  });
});
