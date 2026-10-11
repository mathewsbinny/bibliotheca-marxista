// A title's page as the API renders it: whatever a record holds, it is text on the page, never markup.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { bookJsonLd, libraryIdentifiers, renderBook } from '../server/book.mjs';
import { TEMPLATE, record } from './fixture.mjs';

const publisher = { name: 'Progress <Publishers>', place: 'Moscow' };

describe("rendering a title's page", () => {
  // Open Library is editable by anyone: a record may carry markup, quotes or "$" patterns.
  const hostile = record('x', '<script>alert(1)</script> Wages & "Prices" $1 $&', {
    year: 1970, subtitle: '<img src=x onerror=alert(1)>', authors: [{ name: '</script><script>alert(2)</script>' }],
    links: [{ label: 'Read', url: 'javascript:alert(3)' }, { label: 'Scan (Internet Archive)', url: 'https://archive.org/details/x' }],
    sources: [{ title: 'Record', url: 'javascript:alert(4)' }],
  });
  const page = renderBook(TEMPLATE, hostile, 'progress', publisher, 'https://site.example', '/book/progress/x');
  const scripts = [...page.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];

  test('writes markup in the record as text', () => {
    assert.ok(!page.includes('<script>alert'), 'no script from the record');
    assert.ok(!page.includes('<img src=x'), 'no element from the record');
    assert.match(page, /&lt;script&gt;alert\(1\)&lt;\/script&gt; Wages &amp; &quot;Prices&quot;/);
  });

  test('keeps "$" patterns as they are', () => {
    assert.match(page, /<h1>[^<]*\$1 \$&amp;<\/h1>/);
  });

  test('links only to web addresses', () => {
    assert.ok(!page.includes('javascript:'));
    assert.match(page, /href="https:\/\/archive\.org\/details\/x"/);
  });

  test('keeps its structured data inside its script element', () => {
    assert.equal(scripts.length, 1, 'one script: the structured data');
    const data = JSON.parse(scripts[0][1]);
    assert.equal(data.author[0].name, '</script><script>alert(2)</script>');
  });

  test("names the page's publisher as text too", () => assert.match(page, /Progress &lt;Publishers&gt;/));
});

describe("a title's linked data", () => {
  const r = record('state-and-revolution-1970', 'The State and Revolution', {
    year: 1970, authors: [{ name: 'V. I. Lenin', href: '/authors/lenin' }], translators: ['Clemens Dutt'], editors: ['George Hanna'],
    original_title: 'Gosudarstvo i revoliutsiia',
    sources: [
      { title: 'WorldCat record (OCLC 55201)', url: 'https://search.worldcat.org/title/55201' },
      { title: 'Library of Congress record (LCCN 70009171)', url: 'https://lccn.loc.gov/70009171' },
      { title: 'Open Library', url: 'https://openlibrary.org/books/OL1M' },
    ],
  });
  const data = bookJsonLd(r, { id: 'progress', name: 'Progress Publishers', place: 'Moscow' }, 'https://site.example/book/progress/state-and-revolution-1970');
  test('names its people, with the author\'s page', () => {
    assert.deepEqual(data.author, [{ '@type': 'Person', name: 'V. I. Lenin', url: 'https://site.example/authors/lenin' }]);
    assert.deepEqual(data.translator, [{ '@type': 'Person', name: 'Clemens Dutt' }]);
    assert.deepEqual(data.editor, [{ '@type': 'Person', name: 'George Hanna' }]);
    assert.equal(data.publisher.url, 'https://site.example/publishers/progress');
  });
  test('names the work it translates, and its numbers in library catalogues', () => {
    assert.deepEqual(data.translationOfWork, { '@type': 'CreativeWork', name: 'Gosudarstvo i revoliutsiia' });
    assert.deepEqual(libraryIdentifiers(r), [
      { '@type': 'PropertyValue', propertyID: 'OCLC', value: '55201' },
      { '@type': 'PropertyValue', propertyID: 'LCCN', value: '70009171' },
    ]);
  });
});

describe("a title's other editions", () => {
  const r = record('staat-1970', 'Staat und Revolution', { year: 1970, language: 'German' });
  const editions = [{ href: '/book/progress/gosudarstvo-1969', title: 'Государство и революция', date: '1969', language: 'Russian', publisher: 'Politizdat <Moscow>' }];
  const page = renderBook(TEMPLATE, r, 'dietz', { id: 'dietz', name: 'Dietz', place: 'Berlin' }, 'https://site.example', '/book/dietz/staat-1970',
    { editions, work: { title: 'Gosudarstvo i revoliutsiia', editions: 30 } });
  test('are listed, in their language, with how many more there are', () => {
    assert.match(page, /<h2 id="editions-heading">Other editions of this work<\/h2>/);
    assert.match(page, /<span lang="ru"><a href="\/book\/progress\/gosudarstvo-1969">Государство и революция<\/a><\/span>/);
    assert.match(page, /Politizdat &lt;Moscow&gt;/, 'as text');
    assert.match(page, /And 28 more\./);
    assert.match(page, /"exampleOfWork":\{"@type":"CreativeWork","name":"Gosudarstvo i revoliutsiia"\}/);
  });
});
