#!/usr/bin/env node
/**
 * The catalogue API: search, the large publisher and author tables page by page, single title
 * records and the data download, served from the database built by scripts/build-db.mjs.
 *
 *   GET /api/titles?q=&pub=&author=&lang=&country=&from=&to=&verified=&free=&sort=&offset=&limit=
 *       → { total?, rows } (total only for the first page, offset 0)
 *   GET /api/title?p=<publisher>&t=<title id>   → { record, publisher }
 *   GET /api/export[?pub=<publisher>]            → the catalogue, or one publisher's backlist, as JSON
 *   GET /api/health                              → { titles, built }
 *
 * Environment: PORT (8787), CATALOGUE_DB (db/catalogue.sqlite), SITE_ORIGIN (comma-separated origins
 * allowed by CORS, e.g. https://bibliotheca-marxista.org), TRUST_PROXY=1 behind a reverse proxy.
 * A new database file moved into place (an atomic rename) is opened within a minute.
 */
import { statSync, watchFile } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import Database from 'better-sqlite3';
import { BadRequest, parseTitleParams, titleQuery, toRow } from './query.mjs';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const DB_FILE = process.env.CATALOGUE_DB ?? join(ROOT, 'db', 'catalogue.sqlite');
const PORT = Number(process.env.PORT ?? 8787);
const ORIGINS = new Set((process.env.SITE_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

let db;
function open() {
  const next = new Database(DB_FILE, { readonly: true, fileMustExist: true });
  next.pragma('query_only = ON');
  next.pragma('cache_size = -65536'); // 64 MB
  const previous = db;
  db = next;
  previous?.close();
  console.log(`Opened ${DB_FILE}: ${db.prepare('SELECT count(*) FROM titles').pluck().get()} titles`);
}
open();
// A database replaced by an upload is reopened (a rename keeps readers of the old file working).
let mtime = statSync(DB_FILE).mtimeMs;
watchFile(DB_FILE, { interval: 60_000 }, (s) => {
  if (s.mtimeMs !== mtime) { mtime = s.mtimeMs; try { open(); } catch (e) { console.error('Reopen failed:', e.message); } }
});

// Requests per address: a bucket of 120 that refills at 2 a second; an export costs 30.
const buckets = new Map();
function allow(ip, cost = 1) {
  const now = Date.now();
  const b = buckets.get(ip) ?? { tokens: 120, at: now };
  b.tokens = Math.min(120, b.tokens + ((now - b.at) / 1000) * 2);
  b.at = now;
  buckets.set(ip, b);
  if (b.tokens < cost) return false;
  b.tokens -= cost;
  return true;
}
setInterval(() => { for (const [ip, b] of buckets) if (Date.now() - b.at > 600_000) buckets.delete(ip); }, 600_000).unref();

const json = (res, status, body, cache = 'public, max-age=3600') => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': status === 200 ? cache : 'no-store' });
  res.end(JSON.stringify(body));
};

const statements = new Map();
const prepare = (sql) => {
  const key = `${db.name}|${sql}`;
  if (!statements.has(key) || statements.get(key).database !== db) statements.set(key, db.prepare(sql));
  return statements.get(key);
};

function titles(params, res) {
  const p = parseTitleParams(params);
  const q = titleQuery(p);
  const rows = prepare(q.rows.sql).all(...q.rows.args).map(toRow);
  const body = p.offset === 0 ? { total: prepare(q.count.sql).pluck().get(...q.count.args), rows } : { rows };
  json(res, 200, body);
}

function title(params, res) {
  const p = params.get('p') ?? '', t = params.get('t') ?? '';
  if (!/^[a-z0-9-]{1,120}$/.test(p) || !/^[\p{L}\p{N}-]{1,200}$/u.test(t)) throw new BadRequest('invalid title');
  const href = `/title/?p=${encodeURIComponent(p)}&t=${encodeURIComponent(t)}`;
  const row = prepare('SELECT record FROM titles WHERE href = ?').get(href);
  if (!row) return json(res, 404, { error: 'not found' });
  const publisher = prepare('SELECT id, name, place FROM publishers WHERE id = ?').get(p);
  json(res, 200, { record: JSON.parse(row.record), publisher });
}

let exporting = 0;
/**
 * Streams the catalogue, or one publisher's backlist, as one JSON document — { publishers, titles,
 * authors } — in batches, so a large export neither holds the catalogue in memory nor blocks other
 * requests. Each title carries its page's URL and its authors' page ids.
 */
async function exportCatalogue(params, req, res, origin) {
  const pub = params.get('pub') || undefined;
  if (pub && !/^[a-z0-9-]{1,120}$/.test(pub)) throw new BadRequest('invalid pub');
  if (pub && !prepare('SELECT 1 FROM publishers WHERE id = ?').get(pub)) return json(res, 404, { error: 'not found' });
  if (exporting >= 2) return json(res, 503, { error: 'too many downloads at once; try again shortly' });
  exporting++;
  try {
    const gzip = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="bibliotheca-marxista${pub ? `-${pub}` : ''}.json"`,
      'Cache-Control': 'no-store',
      ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
    });
    const out = gzip ? createGzip() : res;
    if (gzip) out.pipe(res);
    const write = (s) => (out.write(s) ? undefined : new Promise((r) => out.once('drain', r)));
    const publishers = (pub ? prepare('SELECT record FROM publishers WHERE id = ?').all(pub) : prepare('SELECT record FROM publishers ORDER BY name').all())
      .map((r) => r.record);
    await write(`{"publishers":[${publishers.join(',')}],"titles":[`);
    const site = origin || [...ORIGINS][0] || '';
    const batch = prepare(`SELECT rowid, publisher_id, href, record FROM titles WHERE rowid > ?${pub ? ' AND publisher_id = ?' : ''} ORDER BY rowid LIMIT 2000`);
    const credited = new Set();
    let last = 0, first = true;
    for (;;) {
      if (res.destroyed) return;
      const rows = batch.all(...(pub ? [last, pub] : [last]));
      if (!rows.length) break;
      const parts = rows.map((row) => {
        const { authors, copyright: _copyright, ...rest } = JSON.parse(row.record);
        const ids = authors.map((a) => a.href?.split('/').pop() ?? null);
        if (pub) for (const id of ids) if (id) credited.add(id);
        return JSON.stringify({ ...rest, publisherId: row.publisher_id, url: site + row.href, authors: authors.map((a) => a.name), author_ids: ids });
      });
      await write((first ? '' : ',') + parts.join(','));
      first = false;
      last = rows.at(-1).rowid;
      await new Promise((r) => setImmediate(r)); // other requests are served between batches
    }
    const authors = prepare('SELECT id, record FROM authors ORDER BY id').all().filter((a) => !pub || credited.has(a.id)).map((a) => a.record);
    await write(`],"authors":[${authors.join(',')}]}`);
    out.end();
  } finally {
    exporting--;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const origin = req.headers.origin;
  if (origin && ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '86400' }); return res.end(); }
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
  const ip = (TRUST_PROXY && String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()) || req.socket.remoteAddress || '';
  try {
    switch (url.pathname) {
      case '/api/health':
        return json(res, 200, {
          titles: prepare('SELECT count(*) FROM titles').pluck().get(),
          built: prepare("SELECT value FROM meta WHERE key = 'built'").pluck().get(),
        }, 'no-store');
      case '/api/titles':
        if (!allow(ip)) return json(res, 429, { error: 'too many requests' });
        return titles(url.searchParams, res);
      case '/api/title':
        if (!allow(ip)) return json(res, 429, { error: 'too many requests' });
        return title(url.searchParams, res);
      case '/api/export':
        if (!allow(ip, 30)) return json(res, 429, { error: 'too many requests' });
        return await exportCatalogue(url.searchParams, req, res, origin && ORIGINS.has(origin) ? origin : '');
      default:
        return json(res, 404, { error: 'not found' });
    }
  } catch (e) {
    if (e instanceof BadRequest) return json(res, 400, { error: e.message });
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'internal error' });
    else res.destroy();
  }
});
server.listen(PORT, () => console.log(`Catalogue API on http://localhost:${PORT}`));
