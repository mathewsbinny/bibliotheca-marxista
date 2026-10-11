// A title's page as the API renders it: whatever a record holds, it is text on the page, never markup.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderBook } from '../server/book.mjs';
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
