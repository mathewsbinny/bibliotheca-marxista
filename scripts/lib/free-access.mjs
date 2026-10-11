/**
 * Free copies of catalogued titles:
 *
 * - Internet Archive scans are sorted into free ones (read and download) and lending-library ones
 *   (borrow for an hour with an account), from the items' access flags.
 * - HathiTrust full-view scans are found by OCLC number or LCCN; HathiTrust opens a scan only when
 *   its rights review finds it public domain (or openly licensed).
 * - Project Gutenberg ebooks are matched by author surname and title from its catalogue file.
 *
 * Responses are cached in .cache/free-access, so re-runs make no requests.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { ROOT, authorsOverlap, isOffline, slug, surname, titleKey } from './openlibrary.mjs';

const CACHE = join(ROOT, '.cache', 'free-access');
mkdirSync(CACHE, { recursive: true });
const UA = { 'User-Agent': 'LeftBacklist/1.0 (bibliographic research; free-access check)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requests = 0;
export const freeAccessRequests = () => requests;

async function cached(url, parse = (r) => r.json()) {
  const file = join(CACHE, createHash('sha1').update(url).digest('hex'));
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  if (isOffline(url)) return null; // unknown: the host is marked offline
  for (let attempt = 0; attempt < 6; attempt++) {
    requests++;
    const res = await fetch(url, { headers: UA }).catch(() => null);
    if (!res || res.status === 429 || res.status >= 500) { await sleep(1000 * (Number(res?.headers.get('retry-after')) || 4 * 2 ** attempt)); continue; }
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const data = await parse(res);
    writeFileSync(file, JSON.stringify(data));
    await sleep(300);
    return data;
  }
  throw new Error(`gave up on ${url}`);
}

/** HTTP status and body text of a URL, cached; unlike cached() it records 404s instead of failing. */
async function probe(url, pause = 300, maxLength = 20000) {
  const file = join(CACHE, createHash('sha1').update('probe ' + url).digest('hex'));
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  for (let attempt = 0; attempt < 6; attempt++) {
    requests++;
    const res = await fetch(url, { headers: UA }).catch(() => null);
    if (!res || res.status === 429 || res.status >= 500) { await sleep(1000 * (Number(res?.headers.get('retry-after')) || 5 * 2 ** attempt)); continue; }
    const result = { status: res.status, text: res.ok ? (await res.text()).slice(0, maxLength) : '' };
    writeFileSync(file, JSON.stringify(result));
    await sleep(pause);
    return result;
  }
  return { status: 0, text: '' }; // unreachable for now: not cached, so the next run asks again
}

/** NDL Digital Collections serves IIIF only for items open on the internet (インターネット公開). */
async function ndlOpen(url) {
  const pid = url.match(/pid\/(\d+)/)?.[1];
  return pid ? (await probe(`https://dl.ndl.go.jp/api/iiif/${pid}/manifest.json`)).status === 200 : false;
}

/** Gallica's record states the rights: "domaine public", or restricted use for in-copyright books. */
async function gallicaOpen(url) {
  const ark = url.match(/ark:\/12148\/(\w+)/)?.[1];
  if (!ark) return false;
  const { text } = await probe(`https://gallica.bnf.fr/services/OAIRecord?ark=${ark}`, 1500);
  return /<dc:rights[^>]*>\s*(domaine public|public domain)\s*</i.test(text);
}

export const LABELS = {
  iaFree: 'Read or download (Internet Archive)',
  iaBorrow: 'Borrow (Internet Archive)',
  hathi: 'Read or download (HathiTrust)',
  gutenberg: 'Free ebook (Project Gutenberg)',
  ndl: 'Read or download (NDL Digital Collections)',
  gallica: 'Read or download (Gallica)',
  // The Archive's year is often the year of writing, not of the printing, so it is not shown.
  iaOther: 'Read or download another copy (Internet Archive)',
  marxists: 'Full text (marxists.org)',
  mirTitles: 'Read or download (Mir Titles)',
  mirTitlesOther: 'Read or download another copy (Mir Titles)',
};
// Collections whose items are lent rather than freely available.
const LENDING = new Set(['inlibrary', 'printdisabled', 'lendinglibrary', 'cdl', 'internetarchivebooks']);

/** Internet Archive identifier → 'free' | 'borrow'; items no longer on the Archive are absent. */
async function archiveAccess(ids) {
  const access = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const q = `identifier:(${batch.join(' OR ')})`;
    const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=access-restricted-item&fl[]=collection&rows=${batch.length}&output=json`;
    const data = await cached(url);
    if (!data) { for (const id of batch) access.set(id, 'unknown'); continue; } // offline: keep the links as they are
    for (const d of data.response?.docs ?? []) {
      const collections = [].concat(d.collection ?? []);
      const restricted = String(d['access-restricted-item']) === 'true' || collections.some((c) => LENDING.has(c));
      access.set(d.identifier, restricted ? 'borrow' : 'free');
    }
  }
  // The search index misses some items; ask each one directly before calling it withdrawn.
  for (const id of ids.filter((x) => !access.has(x))) {
    const m = await cached(`https://archive.org/metadata/${encodeURIComponent(id)}`);
    if (!m || !m.metadata || m.is_dark) continue;
    const collections = [].concat(m.metadata.collection ?? []);
    const restricted = String(m.metadata['access-restricted-item']) === 'true' || collections.some((c) => LENDING.has(c));
    access.set(id, restricted ? 'borrow' : 'free');
  }
  return access;
}

/** "oclc:123" / "lccn:456" → HathiTrust full-view item URL, for records HathiTrust opens. */
async function hathiFullView(keys) {
  const found = new Map();
  for (let i = 0; i < keys.length; i += 20) {
    const batch = keys.slice(i, i + 20);
    const data = await cached(`https://catalog.hathitrust.org/api/volumes/brief/json/${batch.map(encodeURIComponent).join('|')}`);
    for (const [key, v] of Object.entries(data)) {
      const open = (v.items ?? []).find((it) => it.usRightsString === 'Full view');
      if (open) found.set(key, { url: v.records && Object.values(v.records)[0]?.recordURL || open.itemURL, rights: open.rightsCode });
    }
  }
  return found;
}

/** Project Gutenberg's catalogue, indexed by author surname. */
async function gutenbergIndex() {
  const rows = await cached('https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv', async (res) => parseCsv(await res.text()));
  const [header, ...body] = rows;
  const col = (name) => header.indexOf(name);
  const [id, type, title, authors] = ['Text#', 'Type', 'Title', 'Authors'].map(col);
  const index = new Map();
  for (const r of body) {
    if (r[type] !== 'Text') continue;
    // "Marx, Karl, 1818-1883; Engels, Friedrich, 1820-1895"
    for (const a of String(r[authors] ?? '').split(';')) {
      const s = slug(a.split(',')[0]);
      if (!s) continue;
      if (!index.has(s)) index.set(s, []);
      index.get(s).push({ id: r[id], key: titleKey(String(r[title]).split(/\r?\n/)[0]) });
    }
  }
  return index;
}

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (c === '"') quoted = false; else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------------------
// By author: the Internet Archive and marxists.org, for works whose catalogued edition has no
// free copy. State publishers (Foreign Languages Press, Progress, the Pyongyang and Hanoi houses)
// printed for free distribution, and their editions are widely hosted under the author's name
// even where the Archive item names no publisher.
// ---------------------------------------------------------------------------

/** Same normalisation as nameKey() in src/lib/catalogue.ts. */
function nameKey(name) {
  let n = String(name).replace(/,?\s*\(?\d{4}\s*-\s*(\d{4})?\)?\.?/g, '').trim();
  const parts = n.split(/\s*,\s*/);
  if (parts.length === 2) n = `${parts[1]} ${parts[0]}`;
  return n.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
/** "Roman (native)" credits count under each half, as on the site. */
const creditKeys = (n) => {
  const m = String(n).match(/^(.+?)\s*\(([^()]+)\)\s*$/);
  return [nameKey(n), ...(m ? [nameKey(m[1]), nameKey(m[2])] : [])].filter(Boolean);
};
const LATIN_NAME = /^[\p{Script=Latin}\s.,'’-]+$/u;

/** Publishers in the Soviet Union, whose books Mir Titles collects. */
function sovietPublishers() {
  const dir = join(ROOT, 'data', 'publishers');
  return new Set(readdirSync(dir).filter((f) => f.endsWith('.yaml'))
    .filter((f) => yaml.load(readFileSync(join(dir, f), 'utf8')).country === 'Soviet Union').map((f) => f.slice(0, -5)));
}

function loadAuthors() {
  const dir = join(ROOT, 'data', 'authors');
  return readdirSync(dir).filter((f) => f.endsWith('.yaml')).map((f) => {
    const a = yaml.load(readFileSync(join(dir, f), 'utf8'));
    const names = [a.name, ...(a.alternate_names ?? [])];
    return {
      id: f.slice(0, -5), name: a.name, keys: new Set(names.map(nameKey)),
      latin: [...new Set(names.filter((n) => LATIN_NAME.test(n)).map((n) => n.replace(/,?\s*\d{4}.*$/, '')))],
      marxists: JSON.stringify(a.sources ?? []).match(/https?:\/\/www\.marxists\.org\/[^"]+/)?.[0],
    };
  });
}

/** Free Internet Archive texts credited to an author, under any of their Latin-script names. */
async function archiveByAuthor(a) {
  // "Mao Tse-tung" → (mao AND tse AND tung): word order and commas in Archive names vary.
  const groups = [...new Set(a.latin.map((n) => slug(n).split(' ').filter((w) => w.length > 1).join(' AND ')).filter(Boolean))].slice(0, 6);
  if (!groups.length) return [];
  const q = `creator:(${groups.map((g) => `(${g})`).join(' OR ')}) AND mediatype:(texts)`;
  const found = [];
  for (let page = 1; page <= 10; page++) {
    const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=year&fl[]=date&fl[]=access-restricted-item&fl[]=collection&rows=500&page=${page}&output=json`;
    const data = await cached(url);
    if (!data) break; // offline
    const docs = data.response?.docs ?? [];
    for (const d of docs) {
      const collections = [].concat(d.collection ?? []);
      if (String(d['access-restricted-item']) === 'true' || collections.some((c) => LENDING.has(c))) continue;
      const title = [].concat(d.title ?? [])[0];
      if (!title) continue;
      found.push({ id: d.identifier, key: titleKey(title), year: Number(String(d.year ?? [].concat(d.date ?? [])[0] ?? '').slice(0, 4)) || undefined });
    }
    if (page * 500 >= (data.response?.numFound ?? 0)) break;
  }
  return found;
}

/** marxists.org's own lists of its writers, name key → archive URL. */
async function marxistsWriters() {
  const writers = new Map();
  for (const index of ['https://www.marxists.org/archive/index.htm', 'https://www.marxists.org/reference/archive/index.htm']) {
    const { text } = await probe(index, 1000, 2_000_000);
    for (const [href, label] of anchors(text)) {
      const url = new URL(href, index).href;
      if (/marxists\.org\/(reference\/)?archive\/[^/]+\/?(index\.html?)?$/.test(url)) writers.set(nameKey(label), url.replace(/index\.html?$/, ''));
    }
  }
  return writers;
}

const anchors = (html) =>
  [...String(html).matchAll(/<a\s[^>]*href\s*=\s*"([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => [
    m[1], m[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(),
  ]);

/**
 * Works in an author's marxists.org archive: the titles linked from their index pages, found by
 * following index pages within the archive (up to maxPages, one a second, as robots.txt asks).
 * The largest archives, such as Lenin's Collected Works, run to a couple of hundred index pages.
 */
export async function marxistsWorks(start, maxPages = 600) {
  const base = start.replace(/[^/]*$/, '');
  const queue = [start], seen = new Set(), works = [];
  while (queue.length && seen.size < maxPages) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    // A volume of Collected or Selected Works: "…/lenin/works/cw/volume22.htm",
    // "…/mao/selected-works/volume-1/index.htm".
    const volume = url.match(/(cw|collected|selected)[^/]*\/(?:[^/]*\/)?vol(?:ume)?[-_]?0*(\d+)(?:\/index)?(?:\.html?|\/)?$/i);
    if (volume) works.push({ volume: `${/selected/i.test(volume[1]) ? 'selected' : 'collected'}:${volume[2]}`, url });
    const { status, text } = await probe(url, 1000, 2_000_000);
    if (status !== 200) continue;
    for (const [href, label] of anchors(text)) {
      let target;
      try { target = new URL(href, url).href.replace(/^http:/, 'https:'); } catch { continue; }
      if (!target.startsWith(base) || !/(\/|\.html?)$/.test(target)) continue;
      // Index pages lead to more works; anything else is a work.
      // Collected and Selected Works pages go first, so the largest archives still reach them.
      if (/(cw|collected|selected)/i.test(target) && /(\/|index\.html?|vol\w*\.html?)$/.test(target)) queue.unshift(target);
      else if (/(\/|index\.html?|works\.html?|date\.html?|cw\/?\w*\.html?)$/.test(target)) queue.push(target);
      // A book's own index page ("…/1901/witbd/index.htm") is both a work and a page to follow.
      if (label.split(' ').length >= 2) works.push({ key: titleKey(label), label, url: target });
    }
  }
  return works;
}

// ---------------------------------------------------------------------------
// Mir Titles (mirtitles.org): posts of Soviet books in translation, "Title by Author; Author".
// ---------------------------------------------------------------------------

const decodeEntities = (s) =>
  String(s).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'").replace(/&nbsp;/g, ' ');

async function mirTitlesPosts() {
  const posts = [];
  for (let page = 1; page <= 60; page++) {
    const data = await cached(`https://public-api.wordpress.com/rest/v1.1/sites/mirtitles.org/posts?number=100&page=${page}&fields=ID,title,URL,tags`);
    for (const p of data.posts ?? []) {
      const full = decodeEntities(p.title).trim();
      // The author list follows the last " by ".
      const at = full.toLowerCase().lastIndexOf(' by ');
      const title = at > 0 ? full.slice(0, at) : full;
      const authors = at > 0 ? full.slice(at + 4).split(/\s*(?:;|,|\band\b|&)\s*/).filter(Boolean) : [];
      const year = Object.keys(p.tags ?? {}).map(Number).find((n) => n >= 1917 && n <= 1995);
      // "Machine Elements – A Textbook": match the whole title and the part before the dash or colon.
      const keys = [...new Set([titleKey(title), titleKey(title.split(/\s+[–—-]\s+|:\s/)[0])])].filter((k) => k.length >= 6);
      posts.push({ url: p.URL.replace(/^http:/, 'https:'), keys, authors, year });
    }
    if (page * 100 >= (data.found ?? 0)) break;
  }
  return posts;
}

const idsOf = (t) => {
  const s = JSON.stringify(t.sources ?? []);
  return [
    ...[...s.matchAll(/OCLC (\d+)/g)].map((m) => `oclc:${m[1]}`),
    ...[...s.matchAll(/LCCN ([\w-]+)/g)].map((m) => `lccn:${m[1]}`),
  ];
};

/**
 * Adds free-access links to every title, in place, and returns counts. Internet Archive links are
 * relabelled by access; HathiTrust is checked for titles up to 1963 (later scans are rarely open);
 * Gutenberg is matched for any title whose author and full title agree.
 */
export async function addFreeAccess(titles, publisherOf = new Map()) {
  const soviet = sovietPublishers();
  const stats = { iaFree: 0, iaBorrow: 0, iaGone: 0, hathi: 0, gutenberg: 0, ndl: 0, gallica: 0, restricted: 0, iaByAuthor: 0, marxists: 0, mirTitles: 0 };
  const iaId = (url) => url.match(/archive\.org\/details\/([^/?#]+)/)?.[1];
  const archiveIds = [...new Set(titles.flatMap((t) => (t.links ?? []).map((l) => iaId(l.url)).filter(Boolean)))];
  const access = await archiveAccess(archiveIds);

  const hathiKeys = [...new Set(titles.filter((t) => t.year && t.year <= 1963).flatMap(idsOf))];
  const hathi = await hathiFullView(hathiKeys);
  const gutenberg = await gutenbergIndex();

  for (const t of titles) {
    const links = [];
    for (const l of t.links ?? []) {
      // A national library's own scan: kept only when the library has opened it to everyone.
      if (l.label === 'Digitised copy') {
        if (/dl\.ndl\.go\.jp/.test(l.url) && (await ndlOpen(l.url))) { links.push({ label: LABELS.ndl, url: l.url }); stats.ndl++; }
        else if (/gallica\.bnf\.fr/.test(l.url) && (await gallicaOpen(l.url))) { links.push({ label: LABELS.gallica, url: l.url }); stats.gallica++; }
        // HathiTrust's full view, which the Hathifiles give only for volumes open to readers everywhere.
        else if (/hdl\.handle\.net\/2027\//.test(l.url)) { links.push({ label: LABELS.hathi, url: l.url }); stats.hathi++; }
        else stats.restricted++;
        continue;
      }
      const id = iaId(l.url);
      if (!id) { links.push(l); continue; }
      const a = access.get(id);
      if (!a) { stats.iaGone++; continue; } // withdrawn from the Archive
      if (a === 'unknown') { links.push(l); continue; } // the Archive could not be asked this run
      links.push({ label: a === 'free' ? LABELS.iaFree : LABELS.iaBorrow, url: l.url });
      stats[a === 'free' ? 'iaFree' : 'iaBorrow']++;
    }
    const open = idsOf(t).map((k) => hathi.get(k)).find(Boolean);
    if (open && !links.some((l) => l.url === open.url || l.label === LABELS.hathi)) { links.push({ label: LABELS.hathi, url: open.url }); stats.hathi++; }

    const key = titleKey(t.title);
    const candidates = (t.authors ?? []).flatMap((a) => gutenberg.get(surname(a)) ?? []);
    const pg = key.length > 3 && candidates.find((c) => c.key === key || c.key === titleKey(`${t.title} ${t.subtitle ?? ''}`));
    if (pg) { links.push({ label: LABELS.gutenberg, url: `https://www.gutenberg.org/ebooks/${pg.id}` }); stats.gutenberg++; }

    if (links.length) t.links = links;
    else delete t.links;
  }

  // Works by known writers: free Internet Archive copies under the author's name, for titles with no
  // free copy yet, and full texts in the writer's marxists.org archive, for every title, since a
  // readable transcription is worth having beside a scan.
  const authors = loadAuthors();
  const byKey = new Map();
  for (const a of authors) for (const k of a.keys) byKey.set(k, a);
  const writers = await marxistsWriters();
  const groups = new Map(); // author id → { author, titles }
  const join = (author, t) => (groups.get(author.id) ?? groups.set(author.id, { author, titles: [] }).get(author.id)).titles.push(t);
  for (const t of titles) {
    const keys = (t.authors ?? []).flatMap(creditKeys);
    const a = keys.map((k) => byKey.get(k)).find(Boolean);
    if (a) { join(a, t); continue; }
    // Writers with a marxists.org archive but no file here, by the name the title credits.
    const k = keys.find((x) => writers.has(x));
    if (k) join({ id: `mia:${k}`, name: k, keys: new Set([k]), latin: [], marxists: writers.get(k), archiveOnly: true }, t);
  }
  const isFree = (t) => (t.links ?? []).some((l) => !/^Borrow/.test(l.label));
  const add = (t, link) => { if (!(t.links ?? []).some((l) => l.url === link.url)) t.links = [...(t.links ?? []), link]; };
  // Titles of one word or a few letters ("Poems", "Lenin") are too common to match safely.
  const usable = (k) => k && (k.includes(' ') ? k.length >= 8 : k.length >= 12);
  // "Imperialism, the Highest Stage of Capitalism: A Popular Outline" and "What Is to Be Done?
  // Burning Questions of Our Movement" also match without what follows the colon, dash, ? or ;.
  const variants = (s) => (s ? [titleKey(s), titleKey(s.split(/:\s|\s[—–-]\s|\?\s|;\s/)[0])] : []);
  // A looser key for catalogue slips: small words dropped and each word cut to six letters, so
  // "The Development of Capitalism in Russian" finds "…in Russia". Only for three or more words.
  const SMALL = new Set('the a an of and to in on for by with'.split(' '));
  const loose = (k) => {
    const words = (k ?? '').split(' ').filter((w) => w && !SMALL.has(w)).map((w) => w.slice(0, 6));
    return words.length >= 3 ? `~${words.join(' ')}` : null;
  };
  // "Collected Works / Vol. 22", "Selected Works, Volume 1"
  const volumeOf = (title) => {
    const m = String(title).match(/(collected|selected)\s+works\b.*?\bvol(?:ume)?\.?\s*(\d+)/i);
    return m ? `${m[1].toLowerCase()}:${Number(m[2])}` : null;
  };

  for (const { author: a, titles: list } of groups.values()) {
    // Writers known only from marxists.org need two titles here to be worth crawling.
    if (a.archiveOnly && list.length < 2) continue;
    const needsCopy = a.archiveOnly ? [] : list.filter((t) => !isFree(t));
    const archive = new Map();
    if (needsCopy.length) for (const c of await archiveByAuthor(a)) (archive.get(c.key) ?? archive.set(c.key, []).get(c.key)).push(c);
    const start = a.marxists ?? [...a.keys].map((k) => writers.get(k)).find(Boolean);
    const works = new Map();
    for (const w of start ? await marxistsWorks(start, a.archiveOnly ? 40 : 600) : []) {
      if (w.volume) { if (!works.has(w.volume)) works.set(w.volume, w.url); continue; }
      for (const k of [w.key, ...variants(w.label).slice(1)]) {
        if (!usable(k)) continue;
        if (!works.has(k)) works.set(k, w.url);
        const l = loose(k);
        if (l && !works.has(l)) works.set(l, w.url);
      }
    }

    for (const t of list) {
      const keys = [...new Set([...variants(t.title), ...variants(t.original_title), t.subtitle && titleKey(`${t.title} ${t.subtitle}`)])].filter(usable);
      // Exact title first, then a volume of collected works, then the looser key.
      const text = keys.map((k) => works.get(k)).find(Boolean) ?? works.get(volumeOf(t.title)) ?? keys.map((k) => works.get(loose(k))).find(Boolean);
      if (text) { add(t, { label: LABELS.marxists, url: text }); stats.marxists++; }
      if (!needsCopy.includes(t)) continue;
      const copies = keys.flatMap((k) => archive.get(k) ?? []);
      if (copies.length) {
        // Prefer the same printing; otherwise say which edition the copy is.
        const same = copies.find((c) => c.year && t.year && Math.abs(c.year - t.year) <= 1);
        const c = same ?? copies[0];
        const label = same || !c.year || !t.year ? LABELS.iaFree : LABELS.iaOther;
        add(t, { label, url: `https://archive.org/details/${c.id}` });
        stats.iaByAuthor++;
      }
    }
  }

  // Mir Titles, for the books of Soviet publishers: same title and a shared author surname (or,
  // for books without an author, a title of three words or more).
  const posts = await mirTitlesPosts();
  const byTitle = new Map();
  for (const p of posts) for (const k of p.keys) (byTitle.get(k) ?? byTitle.set(k, []).get(k)).push(p);
  for (const t of titles) {
    if (!soviet.has(publisherOf.get(t))) continue;
    const keys = [titleKey(t.title), t.subtitle && titleKey(`${t.title} ${t.subtitle}`)].filter(Boolean);
    const post = keys.flatMap((k) => byTitle.get(k) ?? []).find((p) =>
      t.authors?.length && p.authors.length ? authorsOverlap(t.authors, p.authors) : titleKey(t.title).split(' ').length >= 3);
    if (!post) continue;
    const sameEdition = !post.year || !t.year || Math.abs(post.year - t.year) <= 1;
    add(t, { label: sameEdition ? LABELS.mirTitles : LABELS.mirTitlesOther, url: post.url });
    stats.mirTitles++;
  }
  return stats;
}
