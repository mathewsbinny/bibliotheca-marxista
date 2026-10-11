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
    env: { ...process.env, PORT: String(port), CATALOGUE_DB: fixture.dbFile, SITE_ORIGIN: ORIGIN, TRUST_PROXY: '1', EXPORT_HOURLY_LIMIT: '1' },
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
    assert.equal(wage.url, `${ORIGIN}/title/?p=international-publishers&t=wage-labour-1933`);
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
