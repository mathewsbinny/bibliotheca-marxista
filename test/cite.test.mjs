// Citations of a title: names as citation styles want them, the three styles, BibTeX and RIS.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bibtex, citationMeta, references, ris, splitName } from '../server/cite.mjs';
import { escapeHtml } from '../server/book.mjs';
import { record } from './fixture.mjs';

const publisher = { name: 'Progress Publishers', place: 'Moscow' };
const lenin = record('state-and-revolution-1970', 'The State and Revolution', {
  year: 1970, subtitle: 'The Marxist Theory of the State', authors: [{ name: 'V. I. Lenin' }], translators: ['Clemens Dutt'],
});
const two = record('x', 'Capital & Labour', { year: 1975, authors: [{ name: 'Karl Marx' }, { name: 'Friedrich Engels' }] });

describe('names', () => {
  test('a person: family name last, particles kept with it', () => {
    assert.deepEqual(splitName('V. I. Lenin'), { family: 'Lenin', given: 'V. I.' });
    assert.deepEqual(splitName('Ludwig van Beethoven'), { family: 'van Beethoven', given: 'Ludwig' });
    assert.deepEqual(splitName('Marx, Karl'), { family: 'Marx', given: 'Karl' });
  });
  test('an organisation is cited as it is named', () => {
    assert.deepEqual(splitName('Communist Party of Great Britain'), { corporate: 'Communist Party of Great Britain' });
  });
});

describe('references', () => {
  const refs = references(lenin, publisher, escapeHtml);
  test('Chicago', () => assert.equal(refs.Chicago,
    'Lenin, V. I. <i>The State and Revolution: The Marxist Theory of the State</i>. Translated by Clemens Dutt. Moscow: Progress Publishers, 1970.'));
  test('MLA', () => assert.equal(refs.MLA,
    'Lenin, V. I. <i>The State and Revolution: The Marxist Theory of the State</i>. Translated by Clemens Dutt, Progress Publishers, 1970.'));
  test('APA', () => assert.equal(refs.APA,
    'Lenin, V. I. (1970). <i>The State and Revolution: The Marxist Theory of the State</i> (Clemens Dutt, Trans.). Progress Publishers.'));
  test('two authors, and markup in a title kept as text', () => {
    const r = references(two, publisher, escapeHtml);
    assert.match(r.Chicago, /^Marx, Karl and Friedrich Engels\. <i>Capital &amp; Labour<\/i>/);
    assert.match(r.MLA, /^Marx, Karl, and Friedrich Engels\./);
    assert.match(r.APA, /^Marx, K\. &amp; Engels, F\. \(1975\)/, 'the ampersand written for HTML');
  });
  test('an undated title', () => assert.match(references(record('u', 'Undated'), publisher, escapeHtml).Chicago, /, n\.d\.$/));
});

describe('files for citation managers', () => {
  test('BibTeX', () => {
    const b = bibtex(lenin, publisher, 'https://site.example/book/progress/state-and-revolution-1970');
    assert.match(b, /^@book\{Lenin1970,\n/);
    assert.match(b, /  author = \{Lenin, V\. I\.\},/);
    assert.match(b, /  title = \{The State and Revolution\},/);
    assert.match(b, /  address = \{Moscow\},/);
    assert.match(b, /  url = \{https:\/\/site\.example\/book\/progress\/state-and-revolution-1970\},/);
    assert.match(bibtex(two, publisher, ''), /title = \{Capital \\& Labour\}/, 'special characters escaped');
  });
  test('RIS', () => {
    const r = ris(lenin, publisher, 'https://site.example/x');
    assert.ok(r.startsWith('TY  - BOOK\r\n'));
    assert.match(r, /AU  - Lenin, V\. I\.\r\n/);
    assert.match(r, /TI  - The State and Revolution: The Marxist Theory of the State\r\n/);
    assert.match(r, /PY  - 1970\r\n/);
    assert.ok(r.endsWith('ER  - \r\n'));
  });
  test('the page head tells Google Scholar and Zotero the citation', () => {
    const m = citationMeta(two, publisher, escapeHtml);
    assert.match(m, /<meta name="citation_title" content="Capital &amp; Labour">/);
    assert.equal((m.match(/citation_author/g) ?? []).length, 2);
    assert.match(m, /<meta name="citation_publication_date" content="1975">/);
  });
});
