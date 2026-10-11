// Editions grouped as works: by author and original title, across houses, languages and the
// romanisations libraries use.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import { workKey, workTitle } from '../server/works.mjs';
import { AUTHOR_TITLES, PUBLISHERS, makeFixture, record } from './fixture.mjs';

describe('work titles', () => {
  test('one title in ALA-LC, ISO 9 and Cyrillic', () => {
    const forms = ['Gosudarstvo i revoli︠u︡t︠s︡ii︠a︡', 'Gosudarstvo i revoljucija', 'Государство и революция', 'Gosudarstvo i revolyutsiya: uchenie marksizma o gosudarstve'];
    assert.equal(new Set(forms.map(workTitle)).size, 1);
    assert.equal(new Set(['Chudožestvennaja literatura', 'Khudozhestvennaia literatura', 'Художественная литература'].map(workTitle)).size, 1);
  });
  test('a leading article and a subtitle are left out', () => {
    assert.equal(workTitle('The State and Revolution: The Marxist Theory of the State'), workTitle('State and Revolution'));
  });
});

describe('work keys', () => {
  const lenin = { author_links: [['V. I. Lenin', 'lenin']] };
  test('a translation joins its original by the original title', () => {
    assert.equal(workKey({ ...lenin, title: 'Staat und Revolution', original_title: 'Gosudarstvo i revoljucija' }),
      workKey({ ...lenin, title: 'Государство и революция' }));
  });
  test('another author, another work', () => {
    assert.notEqual(workKey({ ...lenin, title: 'Capital' }), workKey({ author_links: [['Karl Marx', 'marx']], title: 'Capital' }));
  });
  test('no author, no work', () => assert.equal(workKey({ author_links: [], authors_text: '', title: 'Selected Works' }), undefined));
});

describe('works in the database', () => {
  let fixture, db;
  before(() => {
    fixture = makeFixture();
    const pubs = structuredClone(PUBLISHERS);
    pubs.progress.titles.push(record('staat-und-revolution-1970', 'Staat und Revolution', {
      year: 1970, language: 'German', original_title: 'Gosudarstvo i revoliutsiia', authors: [{ name: 'V. I. Lenin', href: '/authors/lenin' }],
    }));
    pubs.progress.titles.push(record('gosudarstvo-1969', 'Государство и революция', {
      year: 1969, language: 'Russian', authors: [{ name: 'V. I. Lenin', href: '/authors/lenin' }],
    }));
    fixture.exportCatalogue(pubs, AUTHOR_TITLES);
    fixture.build();
    db = new Database(fixture.dbFile, { readonly: true });
  });
  after(() => { db?.close(); fixture.cleanup(); });
  test('groups the editions of a work, named by its original title', () => {
    const works = db.prepare('SELECT title, editions FROM works').all();
    assert.deepEqual(works, [{ title: 'Gosudarstvo i revoliutsiia', editions: 2 }]);
  });
});
