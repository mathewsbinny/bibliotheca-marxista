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
 * allowed by CORS, e.g. https://bibliotheca-marxista.org), TRUST_PROXY=1 behind a reverse proxy that
 * sets X-Real-IP to the client's address (see Caddyfile.example), EXPORT_HOURLY_LIMIT (20: downloads
 * of the whole catalogue, from all clients together, each about 600 MB).
 * A new database file moved into place (an atomic rename) is opened within a minute.
 */
import { statSync, watchFile } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import Database from 'better-sqlite3';
import { escapeHtml, renderBook } from './book.mjs';
import { BadRequest, parseTitleParams, titleQuery, toRow } from './query.mjs';

const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const DB_FILE = process.env.CATALOGUE_DB ?? join(ROOT, 'db', 'catalogue.sqlite');
const PORT = Number(process.env.PORT ?? 8787);
const ORIGINS = new Set((process.env.SITE_ORIGIN ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const EXPORT_HOURLY_LIMIT = Number(process.env.EXPORT_HOURLY_LIMIT ?? 20);

let db;
// Recent answers to searches and title lookups, so a repeated query (a popular page, or the same
// expensive listing asked again and again) is served without asking the database.
const cache = new Map();
const CACHE_SIZE = 2000;
const cached = (key, compute) => {
  if (cache.has(key)) {
    const body = cache.get(key);
    cache.delete(key);
    cache.set(key, body); // most recently used last
    return body;
  }
  const body = compute();
  cache.set(key, body);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  return body;
};
function open() {
  const next = new Database(DB_FILE, { readonly: true, fileMustExist: true });
  next.pragma('query_only = ON');
  next.pragma('cache_size = -65536'); // 64 MB
  const previous = db;
  db = next;
  previous?.close();
  cache.clear();
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

// Sent with every response: JSON is never sniffed as another type, and never runs or embeds anything.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
};
const json = (res, status, body, cacheControl = 'public, max-age=3600') => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': status === 200 ? cacheControl : 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

const statements = new Map();
const prepare = (sql) => {
  const key = `${db.name}|${sql}`;
  if (!statements.has(key) || statements.get(key).database !== db) statements.set(key, db.prepare(sql));
  return statements.get(key);
};

function titles(params, res) {
  const p = parseTitleParams(params);
  json(res, 200, cached(`titles?${new URLSearchParams([...params].sort())}`, () => {
    const q = titleQuery(p);
    const rows = prepare(q.rows.sql).all(...q.rows.args).map(toRow);
    return JSON.stringify(p.offset === 0 ? { total: prepare(q.count.sql).pluck().get(...q.count.args), rows } : { rows });
  }));
}

function title(params, res) {
  const p = params.get('p') ?? '', t = params.get('t') ?? '';
  if (!/^[a-z0-9-]{1,120}$/.test(p) || !/^[\p{L}\p{N}-]{1,200}$/u.test(t)) throw new BadRequest('invalid title');
  const href = `/book/${encodeURIComponent(p)}/${encodeURIComponent(t)}`;
  const row = prepare('SELECT record FROM titles WHERE href = ?').get(href);
  if (!row) return json(res, 404, { error: 'not found' });
  const publisher = prepare('SELECT id, name, place FROM publishers WHERE id = ?').get(p);
  json(res, 200, { record: JSON.parse(row.record), publisher });
}

/** The terms a download is reused under, carried in the file itself. */
const LICENSE = {
  data: 'Open Database License (ODbL) 1.0, https://opendatacommons.org/licenses/odbl/1-0/',
  texts: 'Creative Commons Attribution-ShareAlike 4.0 (descriptions and biographies), https://creativecommons.org/licenses/by-sa/4.0/',
  attribution: 'Bibliotheca Marxista. Includes records of the Bibliothèque nationale de France and ABES (SUDOC), reused under the Licence Ouverte (Etalab); '
    + 'of CiNii Books (National Institute of Informatics), under CC BY 4.0; of the National Diet Library, under its terms for bibliographic data; '
    + "and of HathiTrust, including data from OCLC's WorldCat.",
};

let exporting = 0;
const fullExports = [];
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
  // Whole-catalogue downloads, from all clients together, are capped each hour.
  if (!pub) {
    const hourAgo = Date.now() - 3_600_000;
    while (fullExports.length && fullExports[0] < hourAgo) fullExports.shift();
    if (fullExports.length >= EXPORT_HOURLY_LIMIT) return json(res, 429, { error: 'the whole catalogue has been downloaded many times this hour; please try again later' });
    fullExports.push(Date.now());
  }
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
    await write(`{"license":${JSON.stringify(LICENSE)},"publishers":[${publishers.join(',')}],"titles":[`);
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

/** The site's address, for canonical links and sitemaps: SITE_URL, else the first allowed origin, else the request's host. */
const siteUrl = (req) => (process.env.SITE_URL || [...ORIGINS][0] || `${req.headers['x-forwarded-proto'] ?? 'http'}://${req.headers.host}`).replace(/\/$/, '');
/** Pages are the site's own: the site's Content Security Policy, not the API's deny-all one. */
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; font-src 'self'; "
  + "connect-src 'self'; form-action 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
const html = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': PAGE_CSP,
    'Cache-Control': status === 200 ? 'public, max-age=86400' : 'no-store' });
  res.end(body);
};

/** A title's page (/book/<publisher>/<title>): the site's title page with the record written in. */
function bookPage(p, t, req, res) {
  const template = cached('book-template', () => prepare("SELECT value FROM meta WHERE key = 'book-template'").pluck().get());
  if (!template) return json(res, 503, { error: 'the catalogue has no title page template; rebuild it' });
  const valid = /^[a-z0-9-]{1,120}$/.test(p) && /^[\p{L}\p{N}-]{1,200}$/u.test(t);
  const path = `/book/${encodeURIComponent(p)}/${encodeURIComponent(t)}`;
  const row = valid && prepare('SELECT record FROM titles WHERE href = ?').get(path);
  // Not found: the template as it is (kept out of search engines), whose script says so.
  if (!row) return html(res, 404, template.replace(/(<div class="title-record[^"]*"[^>]*>)[\s\S]*?<\/div>/,
    (_, open) => `${open.replace(/>$/, " data-rendered>")}<p class="meta">This title could not be found. It may have been merged with another record; try <a href="/titles">searching all titles</a>.</p></div>`));
  const publisher = prepare('SELECT id, name, place FROM publishers WHERE id = ?').get(p);
  html(res, 200, cached(`book:${path}`, () => renderBook(template, JSON.parse(row.record), p, publisher, siteUrl(req), path)));
}

/** One of the sitemaps of titles' pages, 50,000 to a file as sitemaps allow (listed in /sitemap.xml). */
const SITEMAP_SIZE = 50_000;
function bookSitemap(n, req, res) {
  const hrefs = n >= 1 ? prepare('SELECT href FROM titles ORDER BY rowid LIMIT ? OFFSET ?').pluck().all(SITEMAP_SIZE, (n - 1) * SITEMAP_SIZE) : [];
  if (!hrefs.length) return json(res, 404, { error: 'not found' });
  const site = siteUrl(req);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + hrefs.map((h) => `<url><loc>${escapeHtml(site + h)}</loc></url>`).join('\n') + '\n</urlset>\n';
  res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
  res.end(xml);
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
  // Behind the proxy, the client's address as the proxy saw it; X-Forwarded-For's first entry is the
  // client's own claim and could be forged to escape the limits.
  const ip = (TRUST_PROXY && String(req.headers['x-real-ip'] ?? '').trim()) || req.socket.remoteAddress || '';
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
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
      default: {
        const book = /^\/book\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
        if (book) {
          if (!allow(ip)) return json(res, 429, { error: 'too many requests' });
          return bookPage(decodeURIComponent(book[1]), decodeURIComponent(book[2]), req, res);
        }
        const sitemap = /^\/sitemap-books-(\d{1,4})\.xml$/.exec(url.pathname);
        if (sitemap) return bookSitemap(Number(sitemap[1]), req, res);
        return json(res, 404, { error: 'not found' });
      }
    }
  } catch (e) {
    if (e instanceof BadRequest) return json(res, 400, { error: e.message });
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'internal error' });
    else res.destroy();
  }
});
server.listen(PORT, () => console.log(`Catalogue API on http://localhost:${PORT}`));
