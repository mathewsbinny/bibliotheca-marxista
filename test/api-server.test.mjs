// The catalogue API over HTTP: the server started on the test catalogue, and asked as the site asks.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ROOT, makeFixture } from './fixture.mjs';

const ORIGIN = 'https://site.example';
let fixture, server, base;

before(async () => {
  fixture = makeFixture();
  const port = 18_000 + Math.floor(Math.random() * 2000);
  server = spawn(process.execPath, [join(ROOT, 'server', 'server.mjs')], {
    env: { ...process.env, PORT: String(port), CATALOGUE_DB: fixture.dbFile, SITE_ORIGIN: ORIGIN, SITE_URL: ORIGIN, TRUST_PROXY: '1', EXPORT_HOURLY_LIMIT: '1', REPORTS_DB: join(fixture.dir, 'reports.sqlite') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => /Catalogue API on/.test(d) && resolve());
    server.on('exit', (code) => reject(new Error(`the server exited (${code})`)));
  });
  base = `http://localhost:${port}`;
});
after(async () => {
  // The database is closed only once the server has exited.
  if (server && server.exitCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); });
  fixture?.cleanup();
});

const get = (path, init) => fetch(base + path, init);

describe('GET /api/titles', () => {
  test('a first page carries the total and compact rows', async () => {
    const res = await get('/api/titles?pub=progress&sort=title');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control'), /public, max-age=3600/);
    const body = await res.json();
    assert.equal(body.total, 3);
    assert.deepEqual(body.rows.map((r) => r[1]), ['Capital', 'Chudožestvennaja literatura i žizn', 'The State and Revolution']);
  });

  test('a later page carries only rows', async () => {
    const body = await (await get('/api/titles?offset=2&limit=2')).json();
    assert.equal(body.total, undefined);
    assert.equal(body.rows.length, 2);
  });

  test('searches the author scope of an author page', async () => {
    const body = await (await get('/api/titles?author=marx')).json();
    assert.equal(body.total, 2);
  });

  test('rejects parameters it does not know how to read', async () => {
    const res = await get('/api/titles?sort=random');
    assert.equal(res.status, 400);
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.deepEqual(await res.json(), { error: 'invalid sort' });
  });
});

describe('GET /api/facets and /api/suggest', () => {
  test('count the titles found by language, country, publisher and decade', async () => {
    const body = await (await get('/api/facets?q=capital')).json();
    assert.deepEqual(body.lang, [['English', 2]]);
    assert.deepEqual(body.decade, [[1930, 1], [1960, 1]]);
  });
  test("the whole catalogue's come from the database as built", async () => {
    const body = await (await get('/api/facets?q=&sort=title')).json();
    assert.equal(body.pub.reduce((n, [, c]) => n + c, 0), 5);
  });
  test('suggest authors, publishers and series', async () => {
    assert.deepEqual(await (await get('/api/suggest?q=marx')).json(), [
      { kind: 'author', label: 'Karl Marx', href: '/authors/marx', titles: 2 },
      { kind: 'series', label: 'Little Marx Library', href: '/titles?series=Little%20Marx%20Library', titles: 2 },
    ]);
    assert.deepEqual(await (await get('/api/suggest?q=m')).json(), []);
    assert.equal((await get('/api/suggest?q=' + 'x'.repeat(101))).status, 400);
  });
  test('filter by series', async () => {
    assert.equal((await (await get('/api/titles?series=Little%20Marx%20Library')).json()).total, 2);
  });
});

describe('GET /api/title', () => {
  test('returns a title and its publisher', async () => {
    const body = await (await get('/api/title?p=progress&t=capital-1965')).json();
    assert.equal(body.record.title, 'Capital');
    assert.deepEqual(body.publisher, { id: 'progress', name: 'Progress Publishers', place: 'Moscow' });
  });

  test('answers 404 for a title that is not there, 400 for a malformed one', async () => {
    assert.equal((await get('/api/title?p=progress&t=no-such-title')).status, 404);
    assert.equal((await get('/api/title?p=Bad_Id&t=x')).status, 400);
  });
});

describe('GET /api/export', () => {
  test("downloads one house's backlist with the authors credited in it", async () => {
    const res = await get('/api/export?pub=international-publishers', { headers: { origin: ORIGIN } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /attachment; filename="bibliotheca-marxista-international-publishers\.json"/);
    const body = await res.json();
    assert.deepEqual(body.publishers.map((p) => p.id), ['international-publishers']);
    assert.equal(body.titles.length, 2);
    const wage = body.titles.find((t) => t.id === 'wage-labour-1933');
    assert.deepEqual([wage.authors, wage.author_ids, wage.publisherId], [['Karl Marx'], ['marx'], 'international-publishers']);
    assert.equal(wage.url, `${ORIGIN}/book/international-publishers/wage-labour-1933`);
    assert.equal(wage.copyright, undefined, 'copyright notes are for the site only');
    assert.deepEqual(body.authors.map((a) => a.id), ['marx']);
    assert.match(body.license.data, /ODbL/, 'the file carries its licence');
    assert.match(body.license.attribution, /Bibliothèque nationale de France/);
  });

  test('downloads the whole catalogue, every author included', async () => {
    const body = await (await get('/api/export?pub=')).json();
    assert.equal(body.publishers.length, 2);
    assert.equal(body.titles.length, 5);
    assert.equal(body.authors.length, 2);
  });

  test('answers 404 for an unknown house', async () => {
    assert.equal((await get('/api/export?pub=no-such-house')).status, 404);
  });

  test('caps downloads of the whole catalogue each hour, from all clients together', async () => {
    // The limit is 1 here, and the whole catalogue was downloaded above.
    const res = await get('/api/export', { headers: { 'x-real-ip': '198.51.100.1' } });
    assert.equal(res.status, 429);
    assert.equal((await get('/api/export?pub=progress', { headers: { 'x-real-ip': '198.51.100.3' } })).status, 200, "one house's backlist is not capped");
  });
});

describe("titles' pages for search engines", () => {
  const headers = { 'x-real-ip': '198.51.100.20' };

  test('a title is a full page, described and filed for search engines', async () => {
    const res = await get('/book/progress/capital-1965', { headers });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/, "the site's policy, not the API's");
    const page = await res.text();
    assert.match(page, /<title>Capital · Bibliotheca Marxista<\/title>/);
    assert.match(page, /<h1>Capital<\/h1>/);
    assert.match(page, /<link rel="canonical" href="https:\/\/site\.example\/book\/progress\/capital-1965">/);
    assert.match(page, /<meta name="description" content="Capital by Karl Marx\. Moscow: Progress Publishers, 1965\. English\.">/);
    assert.doesNotMatch(page, /noindex/);
    const data = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(page)[1]);
    assert.deepEqual([data['@type'], data.name, data.author[0].name, data.publisher.name, data.datePublished], ['Book', 'Capital', 'Karl Marx', 'Progress Publishers', '1965']);
    assert.match(page, /<footer>footer<\/footer>/, "the site's frame is kept");
  });

  test('a title that is not there is a 404 page, kept out of search engines', async () => {
    const res = await get('/book/progress/no-such-title', { headers });
    assert.equal(res.status, 404);
    const page = await res.text();
    assert.match(page, /could not be found/);
    assert.match(page, /noindex/);
  });

  test('the sitemaps list every title on the site\'s address', async () => {
    const xml = await (await get('/sitemap-books-1.xml', { headers })).text();
    assert.equal((xml.match(/<loc>/g) ?? []).length, 5);
    assert.match(xml, /<loc>https:\/\/site\.example\/book\/international-publishers\/wage-labour-1933<\/loc>/);
    assert.equal((await get('/sitemap-books-2.xml', { headers })).status, 404);
  });
});

describe('citing a title', () => {
  const headers = { 'x-real-ip': '198.51.100.30' };
  test("the page offers three styles, and citation managers' files", async () => {
    const page = await (await get('/book/progress/state-and-revolution-1970', { headers })).text();
    assert.match(page, /<h2 id="cite-heading">Cite this<\/h2>/);
    assert.match(page, /id="cite-chicago">Lenin, V\. I\. <i>The State and Revolution<\/i>\. Moscow: Progress Publishers, 1970\./);
    assert.match(page, /<meta name="citation_title" content="The State and Revolution">/);
  });
  test('BibTeX and RIS downloads', async () => {
    const bib = await get('/api/cite?p=progress&t=state-and-revolution-1970&format=bibtex', { headers });
    assert.equal(bib.status, 200);
    assert.match(bib.headers.get('content-disposition'), /attachment; filename="state-and-revolution-1970\.bib"/);
    assert.match(await bib.text(), /^@book\{Lenin1970,/);
    const r = await (await get('/api/cite?p=progress&t=state-and-revolution-1970&format=ris', { headers })).text();
    assert.match(r, /^TY {2}- BOOK/);
    assert.equal((await get('/api/cite?p=progress&t=state-and-revolution-1970&format=pdf', { headers })).status, 400);
  });
});

describe('reporting an error', () => {
  const post = (body, ip, { json = true } = {}) => get('/api/report', {
    method: 'POST',
    headers: json ? { 'content-type': 'application/json', accept: 'application/json', 'x-real-ip': ip } : { 'content-type': 'application/x-www-form-urlencoded', 'x-real-ip': ip },
    body: json ? JSON.stringify(body) : new URLSearchParams(body).toString(),
    redirect: 'manual',
  });
  const stored = async () => {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(join(fixture.dir, 'reports.sqlite'), { readonly: true });
    const rows = db.prepare('SELECT * FROM reports ORDER BY id').all();
    db.close();
    return rows;
  };

  test("each title's page has the form", async () => {
    const page = await (await get('/book/progress/capital-1965', { headers: { 'x-real-ip': '198.51.100.40' } })).text();
    assert.match(page, /<form class="report-form" method="post" action="\/api\/report">/);
    assert.match(page, /name="kind" value="date"/);
  });

  test('a report from the page script is stored, as the reader wrote it', async () => {
    const res = await post({ p: 'progress', t: 'capital-1965', kind: 'date', message: 'First published in <1867>, not 1965.' }, '198.51.100.41');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    const [r] = await stored();
    assert.deepEqual([r.href, r.title, r.kind, r.message, r.status], ['/book/progress/capital-1965', 'Capital', 'date', 'First published in <1867>, not 1965.', 'open']);
  });

  test('a report from a plain form gets a page of thanks', async () => {
    const res = await post({ p: 'progress', t: 'capital-1965', kind: 'other' }, '198.51.100.42', { json: false });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<h1>Thank you<\/h1>/);
  });

  test('a bot filling in the hidden field is told nothing, and nothing is stored', async () => {
    const before = (await stored()).length;
    assert.equal((await post({ p: 'progress', t: 'capital-1965', kind: 'date', website: 'http://spam.example' }, '198.51.100.43')).status, 200);
    assert.equal((await stored()).length, before);
  });

  test('refuses unknown titles and kinds, and overlong messages', async () => {
    assert.equal((await post({ p: 'progress', t: 'no-such-title', kind: 'date' }, '198.51.100.44')).status, 404);
    assert.equal((await post({ p: 'progress', t: 'capital-1965', kind: 'spam' }, '198.51.100.44')).status, 400);
    assert.equal((await post({ p: 'progress', t: 'capital-1965', kind: 'other', message: 'x'.repeat(2001) }, '198.51.100.44')).status, 400);
  });

  test('takes at most five reports an hour from one address', async () => {
    const statuses = [];
    for (let i = 0; i < 7; i++) statuses.push((await post({ p: 'progress', t: 'capital-1965', kind: 'other' }, '198.51.100.45')).status);
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429]);
  });

  test('accepts only POST', async () => {
    assert.equal((await get('/api/report', { headers: { 'x-real-ip': '198.51.100.46' } })).status, 405);
  });
});

describe('the server', () => {
  test('allows the site, and only the site, to call it from a browser', async () => {
    assert.equal((await get('/api/titles?limit=1', { headers: { origin: ORIGIN } })).headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal((await get('/api/titles?limit=1', { headers: { origin: 'https://elsewhere.example' } })).headers.get('access-control-allow-origin'), null);
  });

  test('accepts only GET, HEAD and CORS preflight', async () => {
    assert.equal((await get('/api/titles', { method: 'POST' })).status, 405);
    assert.equal((await get('/api/titles', { method: 'OPTIONS', headers: { origin: ORIGIN } })).status, 204);
  });

  test('reports its catalogue', async () => {
    const body = await (await get('/api/health')).json();
    assert.equal(body.titles, 5);
    assert.match(body.built, /^\d{4}-\d\d-\d\dT/);
  });

  test('answers 404 elsewhere', async () => {
    assert.equal((await get('/api/nothing')).status, 404);
  });

  test('limits how fast one address may ask (behind the proxy, by the X-Real-IP it sets)', async () => {
    const statuses = [];
    const headers = { 'x-real-ip': '203.0.113.7' };
    for (let i = 0; i < 140; i++) statuses.push((await get('/api/titles?limit=1', { headers })).status);
    assert.ok(statuses.includes(429), 'some requests are refused');
    assert.ok(statuses.slice(0, 50).every((s) => s === 200), 'but not the first ones');
  });

  test('cannot be escaped by forging X-Forwarded-For', async () => {
    // Without X-Real-IP, every request counts against the connection's own address, whatever it claims.
    const statuses = [];
    for (let i = 0; i < 140; i++) statuses.push((await get('/api/titles?limit=1', { headers: { 'x-forwarded-for': `192.0.2.${i}` } })).status);
    assert.ok(statuses.includes(429));
  });

  test('sends security headers with every response', async () => {
    for (const path of ['/api/titles?limit=1', '/api/nothing', '/api/titles?sort=random']) {
      const res = await get(path, { headers: { 'x-real-ip': '198.51.100.2' } });
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff', path);
      assert.match(res.headers.get('content-security-policy'), /default-src 'none'/, path);
    }
  });
});
