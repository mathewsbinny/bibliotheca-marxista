/**
 * Records from sources other than Open Library, for cross-referencing the catalogue:
 *
 *   - the Internet Archive (scanned books, including the Mir titles collection of Soviet books)
 *   - BannedThought.net (PDFs of Maoist-era Chinese, DPRK, Philippine and South Asian literature)
 *
 * Both are turned into edition-like records ({ publishers, publish_places, publish_date, title,
 * ... }) so they can be judged by the same publisher rules as Open Library editions.
 * Responses are cached alongside the Open Library cache.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, isOffline } from './openlibrary.mjs';

const CACHE = join(ROOT, '.cache', 'sources');
const USER_AGENT = 'LeftBacklist/1.0 (bibliographic research)';
mkdirSync(CACHE, { recursive: true });

let lastRequest = 0;
export let sourceRequests = 0;

async function getText(url) {
  const file = join(CACHE, createHash('sha1').update(url).digest('hex') + '.txt');
  if (existsSync(file)) return readFileSync(file, 'utf8');
  if (isOffline(url)) return '';
  for (let attempt = 1; ; attempt++) {
    // CiNii blocks a client that searches quickly (HTTP 403), so it is given more time.
    const wait = lastRequest + (url.includes('ci.nii.ac.jp') ? 1500 : 700) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
    sourceRequests++;
    try {
      // A stalled connection is given up after three minutes and retried, not left to block the import.
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(180_000) });
      if (res.ok) {
        const text = await res.text();
        writeFileSync(file, text);
        return text;
      }
      if (res.status === 404) { writeFileSync(file, ''); return ''; }
      if (![429, 500, 502, 503, 504].includes(res.status)) throw new Error(`HTTP ${res.status} ${url}`);
    } catch (err) {
      if (attempt >= 5) throw err;
    }
    if (attempt >= 5) throw new Error(`Giving up on ${url}`);
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
}

// ---------------------------------------------------------------------------
// Internet Archive
// ---------------------------------------------------------------------------

const IA_FIELDS = ['identifier', 'title', 'creator', 'date', 'year', 'language', 'publisher'];

/** "Peking : Foreign Languages Press" → { place: "Peking", publisher: "Foreign Languages Press" } */
function splitImprint(imprint) {
  const s = String(imprint ?? '').replace(/\s+/g, ' ').trim();
  const m = s.match(/^([^:;]{2,40}?)\s*:\s*(.+)$/);
  return m ? { place: m[1].replace(/^\[|\]$/g, ''), publisher: m[2] } : { place: '', publisher: s };
}

const first = (v) => (Array.isArray(v) ? v[0] : v);

/** Internet Archive items whose publisher field matches a search term, as edition-like records. */
export async function internetArchiveItems(term) {
  const items = [];
  for (let page = 1; page <= 20; page++) {
    // Quotation marks inside a term (Izd-vo "Pravda") would end the Archive's quoted phrase.
    const phrase = String(term).replace(/["“”«»]/g, ' ').replace(/\s+/g, ' ').trim();
    const params = new URLSearchParams({ q: `publisher:("${phrase}") AND mediatype:(texts)`, rows: '500', page: String(page), output: 'json' });
    for (const f of IA_FIELDS) params.append('fl[]', f);
    const text = await getText(`https://archive.org/advancedsearch.php?${params}`);
    if (!text) break;
    const { response } = JSON.parse(text);
    if (!response?.docs) break; // the Archive rejected the query
    for (const d of response.docs) {
      const imprint = splitImprint(first(d.publisher));
      items.push({
        source: 'Internet Archive',
        key: `ia:${d.identifier}`,
        url: `https://archive.org/details/${d.identifier}`,
        title: first(d.title),
        creators: [].concat(d.creator ?? []),
        publishers: [imprint.publisher],
        publish_places: imprint.place ? [imprint.place] : [],
        publish_date: String(d.year ?? first(d.date) ?? ''),
        languageNames: [].concat(d.language ?? []),
      });
    }
    if (page * 500 >= response.numFound) break;
  }
  return items;
}

// ---------------------------------------------------------------------------
// BannedThought.net
// ---------------------------------------------------------------------------

const BT = 'https://www.bannedthought.net/';
// Sections covering publishers in the catalogue; linked sub-indexes are followed one level down.
const BT_SECTIONS = [
  'China/MaoEra/index.htm', 'China/Individuals/index.htm', 'Korea-DPRK/index.htm', 'Philippines/index.htm',
  'Bangladesh/index.htm', 'India/NewVistas/index.htm', 'India/EarlyHistory/index.htm', 'Thailand/index.htm',
];

// Imprint abbreviations used on the site.
const BT_ABBREVIATIONS = [
  [/^FLPH$/i, 'Foreign Languages Publishing House'],
  [/^FLP$/i, 'Foreign Languages Press'],
  [/^L\s*&\s*W$/i, 'Lawrence & Wishart'],
  [/^MR\s+Press$/i, 'Monthly Review Press'],
  [/^IP$/i, 'International Publishers'],
];
const BT_PLACES = [[/^NY$/i, 'New York']];

// HTML accent entities ("&aacute;", "&ntilde;") → combining marks, then composed.
const ACCENTS = { acute: '́', grave: '̀', tilde: '̃', uml: '̈', circ: '̂', cedil: '̧' };
const decode = (s) =>
  s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&([a-z])(acute|grave|tilde|uml|circ|cedil);/gi, (_, c, a) => (c + ACCENTS[a]).normalize('NFC'))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const stripTags = (s) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * Parses the <li> entries of one BannedThought page into edition-like records. An entry may list
 * several editions (e.g. English and Spanish), each on its own line with its own bold title,
 * imprint and link, so entries are split into those segments first.
 */
function parseBannedThoughtPage(html, pageUrl) {
  const records = [];
  const segments = html.split(/<li[\s>]/i).slice(1)
    .flatMap((chunk) => chunk.split(/<\/li>|<li[\s>]/i)[0].split(/<br\s*\/?>/i));
  for (const segment of segments) {
    const titleMatch = segment.match(/<b>([\s\S]*?)<\/b>/i);
    const link = segment.match(/href="([^"]+\.(?:pdf|djvu))"/i)?.[1];
    if (!titleMatch || !link) continue;
    const text = stripTags(segment);
    // The imprint in brackets: "(Pyongyang: FLPH, 2018)", "(Peking: FLP, 1st ed., 1962)".
    const imprints = [...text.matchAll(/\(([^():]{2,40}):\s*([^():]{2,80}?),\s*(?:[^(),]*\bed\.?,\s*)?((?:1[89]|20)\d\d)\)/g)];
    if (!imprints.length) continue;
    const [, rawPlace, rawPublisher, year] = imprints.at(-1);
    const cleanPublisher = rawPublisher.replace(/,\s*[^,]*\bed\.?$/i, '').trim();
    const publisher = BT_ABBREVIATIONS.find(([re]) => re.test(cleanPublisher))?.[1] ?? cleanPublisher;
    const place = BT_PLACES.find(([re]) => re.test(rawPlace.trim()))?.[1] ?? rawPlace.trim();
    const title = stripTags(titleMatch[1]).replace(/^["“”']+|["“”']+$/g, '').replace(/,$/, '');
    // Only a "by …" directly after the title names the author, not one inside an explanatory note.
    const afterTitle = stripTags(segment.slice(titleMatch.index + titleMatch[0].length));
    const author = afterTitle.match(/^,?\s*by\s+([^,(]{3,80})/)?.[1]?.trim().replace(/\.$/, '');
    const language = text.match(/\b(English|Spanish|French|German|Russian|Chinese|Korean|Tagalog|Filipino|Bengali|Hindi|Telugu):\s/)?.[1];
    records.push({
      source: 'BannedThought.net',
      key: `bt:${new URL(link, pageUrl).href}`,
      url: new URL(link, pageUrl).href,
      pageUrl,
      title,
      creators: author ? [author] : [],
      publishers: [publisher],
      publish_places: [place],
      publish_date: year,
      languageNames: language ? [language] : ['English'],
    });
  }
  return records;
}

/** All parseable entries from the BannedThought sections above, following sub-indexes one level. */
export async function bannedThoughtItems() {
  const seen = new Set();
  const records = [];
  const visit = async (path, depth) => {
    const url = new URL(path, BT).href;
    if (seen.has(url) || seen.size > 150) return;
    seen.add(url);
    const html = await getText(url);
    if (!html) return;
    records.push(...parseBannedThoughtPage(html, url));
    if (depth === 0) return;
    const base = url.replace(/[^/]+$/, '');
    for (const m of html.matchAll(/href="([^"#]+\/index\.htm)"/gi)) {
      const next = new URL(m[1], url).href;
      if (next.startsWith(base) && next !== url) await visit(next, depth - 1);
    }
  };
  for (const section of BT_SECTIONS) await visit(section, 1);
  const unique = new Map(records.map((r) => [r.key + r.title, r]));
  return [...unique.values()];
}

// ---------------------------------------------------------------------------
// National library catalogues: German National Library (DNB), Bibliothèque nationale de France
// (BnF) and the National Diet Library of Japan (NDL). Their records are library-catalogued, so a
// record that passes a publisher rule's place and date checks counts as verified.
// ---------------------------------------------------------------------------

const xmlText = (s) => String(s ?? '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&')
  .replace(/[\u0098\u009c]/g, '') // MARC non-filing markers
  .trim();

/** Fields of a MARCXML or marcxchange record: { tag: [{ ind2, sub: { code: [values] } }] }. */
function marcFields(xml) {
  const fields = {};
  // Attributes come in any order: tag="245" ind1="1" … or ind1=" " ind2=" " tag="035".
  const tagOf = (attrs) => (attrs.match(/\btag="(\w+)"/) ?? [])[1];
  for (const m of xml.matchAll(/<(?:\w+:)?controlfield\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?controlfield>/g)) {
    const tag = tagOf(m[1]);
    if (tag) (fields[tag] ??= []).push({ value: xmlText(m[2]) });
  }
  for (const m of xml.matchAll(/<(?:\w+:)?datafield\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?datafield>/g)) {
    const tag = tagOf(m[1]);
    if (!tag) continue;
    const sub = {};
    for (const s of m[2].matchAll(/<(?:\w+:)?subfield code="(\w)">([\s\S]*?)<\/(?:\w+:)?subfield>/g)) (sub[s[1]] ??= []).push(xmlText(s[2]));
    (fields[tag] ??= []).push({ ind1: (m[1].match(/ind1="(.)"/) ?? [])[1], ind2: (m[1].match(/ind2="(.)"/) ?? [])[1], sub });
  }
  return fields;
}
const sf = (fields, tag, code) => (fields[tag] ?? []).flatMap((f) => f.sub?.[code] ?? []);

// A person's role in a record: MARC 21's relator code ($4) or term ($e), in the catalogues' languages.
const TRANSLATOR = /\btrl\b|transl|übers|tradu|перев|perev|t[łl]um|přel|prekl|ford[ií]t|превод|prevod|vertal|övers|käänt/i;
const EDITOR = /\b(edt|edc|com|pbd)\b|\bed(itor|\.|s\.)|hrsg|herausg|redakt|\bred\.|compil|sost|zusammengest|bearb|szerk|uspořád|opracow|wyb[oó]r/i;
const AUTHOR = /\b(aut|cre)\b|^author|verfasser|auteur|autor|szerző/i;

/**
 * The people of a MARC 21 record by role: its main entry (100, 110) and added entries (700, 710),
 * each read by its relator. An added entry with no relator counts as an author, as catalogues
 * leave co-authors uncoded; one coded for another role (an illustrator, the writer of a preface)
 * is left out.
 */
export function marc21People(f, sub = (x, code) => x.sub?.[code] ?? []) {
  const creators = [], translators = [], editors = [];
  // As recorded ("Lenin, V. I.,"): displayAuthor tidies names, keeping the full stops of initials.
  const name = (x) => sub(x, 'a')[0]?.trim();
  for (const tag of ['100', '110']) for (const x of f[tag] ?? []) if (name(x)) creators.push(name(x));
  for (const tag of ['700', '710']) {
    for (const x of f[tag] ?? []) {
      if (!name(x) || sub(x, 't').length) continue; // an entry for another work ($t), not a person of this one
      const role = [...sub(x, '4'), ...sub(x, 'e')].join(' ');
      if (!role || AUTHOR.test(role)) creators.push(name(x));
      else if (TRANSLATOR.test(role)) translators.push(name(x));
      else if (EDITOR.test(role)) editors.push(name(x));
    }
  }
  return { creators, translators, editors };
}

/**
 * The title a MARC 21 record was translated from: the original-language entry (765), else the
 * uniform title (240) when the record says it is a translation (240 $l, a 041 first indicator of 1,
 * a 041 $h, or a translator), else a "Translation of:" note (500).
 */
export function marc21Original(f, translated, sub = (x, code) => x.sub?.[code] ?? []) {
  // "Historie of the raigne of King Henry the Seventh <russ.>": the German National Library's language tag goes.
  const tidy = (s) => trimPunct(s.replace(/\s*<[^<>]*>\s*$/, '').replace(/\.\s*$/, '')) || undefined;
  const first = (tag, code) => (f[tag] ?? []).flatMap((x) => sub(x, code))[0];
  const original = first('765', 't');
  if (original) return tidy(original);
  const isTranslation = translated || (f['240'] ?? []).some((x) => sub(x, 'l').length)
    || (f['041'] ?? []).some((x) => x.ind1 === '1' || sub(x, 'h').length);
  const uniform = first('240', 'a');
  if (isTranslation && uniform && !/^(works|selections|correspondence|letters|speeches|essays|poems|novels|short stories|werke|œuvres|oeuvres|sočinenija|sochineniia|polnoe sobranie|izbrannoe|izbrannye)\b/i.test(uniform)) return tidy(uniform);
  const note = (f['500'] ?? []).flatMap((x) => sub(x, 'a')).map((a) => /^(?:translation of|translated from|übers(?:\.|etzung) (?:von|aus)[^:]*|einheitssacht\.?|originaltitel|titre original|título original|tytuł oryginału)\s*:\s*(.+)$/i.exec(a)?.[1]).find(Boolean);
  return note ? tidy(note) : undefined;
}

/** A record's people and original title, as the import's records carry them (empty ones left out). */
function withPeople({ creators, translators, editors }, original) {
  const originalTitle = original(translators.length > 0);
  return {
    creators,
    ...(translators.length ? { translators } : {}),
    ...(editors.length ? { editors } : {}),
    ...(originalTitle ? { originalTitle } : {}),
  };
}

/** UNIMARC (BnF, SUDOC): 700–702 by role code ($4: 070 author, 730 translator, 340 editor); 702 without one is not an author. */
export function unimarcPeople(f, person) {
  const creators = [], translators = [], editors = [];
  for (const tag of ['700', '701', '702']) {
    for (const x of f[tag] ?? []) {
      const name = person(x);
      if (!name) continue;
      const roles = x.sub?.['4'] ?? [];
      if (roles.includes('730')) translators.push(name);
      else if (roles.some((r) => ['340', '651'].includes(r))) editors.push(name);
      else if (roles.includes('070') || (!roles.length && tag !== '702')) creators.push(name);
    }
  }
  return { creators, translators, editors };
}

/** UNIMARC's original title: the translated-from entry (454 $t), else the uniform title (500) of a translation (101 first indicator 1, or 101 $c). */
export function unimarcOriginal(f, translated) {
  const original = sf(f, '454', 't')[0];
  if (original) return trimPunct(original);
  const isTranslation = translated || (f['101'] ?? []).some((x) => x.ind1 === '1' || x.sub?.c?.length);
  const uniform = sf(f, '500', 'a')[0];
  return isTranslation && uniform ? trimPunct(uniform) : undefined;
}
const trimPunct = (s) => String(s ?? '').replace(/\s*[/:;,=.]\s*$/, '').replace(/^\[|\]$/g, '').trim();

/** Library abbreviations in imprints, spelled out so publisher rules recognise them. */
function expandImprint(p) {
  return trimPunct(p)
    .replace(/\bVerl\.(?=\s|$|-)/g, 'Verlag').replace(/-Verl\b\.?/g, '-Verlag')
    .replace(/\bBuchh\.(?=\s|$)/g, 'Buchhandlung').replace(/\bGes\.(?=\s|$)/g, 'Gesellschaft')
    .replace(/^[ÉE]d\.\s+/, 'Éditions ').replace(/^[ÉE]ds\.\s+/, 'Éditions ')
    .replace(/\s+/g, ' ');
}

async function sruRecords(base, query, schema, pageSize, maxPages) {
  const records = [];
  for (let page = 0; page < maxPages; page++) {
    const url = `${base}?version=${/bnf|slsp|bne/.test(base) ? '1.2' : '1.1'}&operation=searchRetrieve&query=${encodeURIComponent(query)}`
      + `&recordSchema=${schema}&maximumRecords=${pageSize}&startRecord=${page * pageSize + 1}`;
    const xml = await getText(url);
    if (!xml) break;
    const recs = [...xml.matchAll(/<(?:\w+:)?recordData>([\s\S]*?)<\/(?:\w+:)?recordData>/g)].map((m) => m[1]);
    records.push(...recs);
    const total = Number((xml.match(/<(?:\w+:)?numberOfRecords>(\d+)</) ?? [])[1] ?? 0);
    if (!recs.length || (page + 1) * pageSize >= total) break;
  }
  return records;
}

/** German National Library records whose publisher (vlg) index, or another index (per: persons, koe: bodies), matches a term. */
export async function dnbRecords(term, index = 'vlg', year) {
  // A year (the jhr index) splits a large house's list into smaller searches.
  const query = `${index}="${term}"${year ? ` and jhr=${year}` : ''}`;
  const xmls = await sruRecords('https://services.dnb.de/sru/dnb', query, 'MARC21-xml', 100, index === 'vlg' ? 100 : 2);
  return xmls.map((xml) => {
    const f = marcFields(xml);
    const id = f['001']?.[0]?.value;
    const imprint = (f['264'] ?? []).find((x) => x.ind2 === '1') ? '264' : '260';
    const f008 = f['008']?.[0]?.value ?? '';
    return {
      source: 'German National Library', catalogued: true, key: `dnb:${id}`,
      url: `https://d-nb.info/${id}`, recordLabel: `German National Library record ${id}`,
      title: trimPunct(sf(f, '245', 'a')[0]), subtitle: trimPunct(sf(f, '245', 'b')[0]) || undefined,
      ...withPeople(marc21People(f), (translated) => marc21Original(f, translated)),
      publishers: sf(f, imprint, 'b').map(expandImprint),
      publish_places: sf(f, imprint, 'a').map(trimPunct),
      publish_date: sf(f, imprint, 'c')[0] ?? f008.slice(7, 11), coded_year: f008.slice(7, 11),
      languageNames: sf(f, '041', 'a').length ? sf(f, '041', 'a') : [f008.slice(35, 38)].filter((c) => /^[a-z]{3}$/.test(c)),
    };
  }).filter((r) => r.title);
}

/**
 * Library of Congress records found by a keyword search for a term (its SRU service has no
 * publisher index), so the import's publisher rules decide which records belong to which house.
 */
export async function locRecords(term, maxPages = 10, year) {
  // The server finds nothing for a term with diacritics or ʻayn marks ("al-Ḥizb al-Shuyūʻī"), though
  // its records carry them: search the plain letters.
  const plain = term.normalize('NFKD').replace(/[̀-ͯ︠-︯]/g, '').replace(/[ʻʼʿʾ‘’']/g, '');
  // A year splits a large house's list into searches under the 1,000-record cap.
  const xmls = await sruRecords('http://lx2.loc.gov:210/lcdb', `"${plain}"${year ? ` and dc.date=${year}` : ''}`, 'marcxml', 100, maxPages);
  return xmls.map((xml) => {
    const f = marcFields(xml);
    const lccn = (sf(f, '010', 'a')[0] ?? '').replace(/\s+/g, '');
    const id = lccn || f['001']?.[0]?.value;
    const imprint = (f['264'] ?? []).find((x) => x.ind2 === '1') ? '264' : '260';
    const f008 = f['008']?.[0]?.value ?? '';
    return {
      source: 'Library of Congress', catalogued: true, key: `loc:${id}`,
      url: lccn ? `https://lccn.loc.gov/${lccn}` : `https://catalog.loc.gov/`, recordLabel: `Library of Congress record ${id}`,
      title: trimPunct(sf(f, '245', 'a')[0]), subtitle: trimPunct(sf(f, '245', 'b')[0]) || undefined,
      // The series and number (490, or the controlled form in 830): "New World paperbacks ; NW-24".
      series: [...sf(f, '490', 'a').map((a, i) => [a, sf(f, '490', 'v')[i]]), ...sf(f, '830', 'a').map((a, i) => [a, sf(f, '830', 'v')[i]])]
        .map(([a, v]) => trimPunct([trimPunct(a), v].filter(Boolean).join(' ; ')))[0] || undefined,
      ...withPeople(marc21People(f), (translated) => marc21Original(f, translated)),
      publishers: sf(f, imprint, 'b').map(expandImprint),
      publish_places: sf(f, imprint, 'a').map(trimPunct),
      publish_date: sf(f, imprint, 'c')[0] ?? f008.slice(7, 11), coded_year: f008.slice(7, 11),
      languageNames: sf(f, '041', 'a').length ? sf(f, '041', 'a') : [f008.slice(35, 38)].filter((c) => /^[a-z]{3}$/.test(c)),
    };
  }).filter((r) => r.title && r.publishers.length);
}

/**
 * National Library of Poland records whose publisher matches a term, from its open JSON API
 * (data.bn.org.pl), which carries each record's MARC fields. The API's publisher search is loose,
 * so the import's publisher rules decide which records belong to which house.
 */
export async function polishRecords(term, param = 'publisher') {
  const records = [];
  let url = `https://data.bn.org.pl/api/institutions/bibs.json?${param}=${encodeURIComponent(term)}&limit=100`;
  for (let page = 0; url && page < (param === 'publisher' ? 30 : 3); page++) {
    const text = await getText(url);
    if (!text) break;
    const data = JSON.parse(text);
    for (const b of data.bibs ?? []) {
      if (b.deleted) continue;
      const field = (tag) => (b.marc?.fields ?? []).filter((f) => f[tag]).map((f) => f[tag]);
      const sub = (tag, code) => field(tag).flatMap((f) => (f.subfields ?? []).filter((s) => s[code] !== undefined).map((s) => String(s[code])));
      // The record's fields in the shape the MARC 21 readers take: { tag: [field] }.
      const fields = {};
      for (const x of b.marc?.fields ?? []) for (const [tag, v] of Object.entries(x)) (fields[tag] ??= []).push(v);
      const subOf = (x, code) => (x.subfields ?? []).filter((s) => s[code] !== undefined).map((s) => String(s[code]));
      const mms = field('009')[0] ?? b.id;
      const oclc = sub('035', 'a').map((a) => a.match(/^\(OCoLC\)(\d+)/)?.[1]).find(Boolean);
      const imprint = field('264').length ? '264' : '260';
      const f008 = String(field('008')[0] ?? '');
      records.push({
        source: 'National Library of Poland', catalogued: true, key: `bn:${mms}`,
        url: `https://katalogi.bn.org.pl/discovery/fulldisplay?docid=alma${mms}&vid=48OMNIS_NLOP:48OMNIS_NLOP`,
        recordLabel: `National Library of Poland record ${mms}`,
        ...(oclc ? { oclc } : {}),
        title: trimPunct(sub('245', 'a')[0]), subtitle: trimPunct(sub('245', 'b')[0]) || undefined,
        ...withPeople(marc21People(fields, subOf), (translated) => marc21Original(fields, translated, subOf)),
        publishers: sub(imprint, 'b').map((p) => expandImprint(trimPunct(p))),
        publish_places: sub(imprint, 'a').map(trimPunct),
        publish_date: b.publicationYear || f008.slice(7, 11),
        languageNames: [f008.slice(35, 38)].filter((c) => /^[a-z]{3}$/.test(c)),
      });
    }
    url = data.nextPage && (data.bibs ?? []).length ? data.nextPage : null;
  }
  return records.filter((r) => r.title);
}

/** Bibliothèque nationale de France records whose publisher (or another index, e.g. bib.author) matches a term. */
export async function bnfRecords(term, index = 'bib.publisher') {
  const xmls = await sruRecords('https://catalogue.bnf.fr/api/SRU', `${index} all "${term}"`, 'unimarcxchange', 50, index === 'bib.publisher' ? 200 : 2);
  return xmls.map((xml) => {
    const f = marcFields(xml);
    const ark = (f['003']?.[0]?.value ?? '').replace(/^https?:\/\//, 'https://');
    const imprint = f['214'] ? '214' : '210';
    const people = unimarcPeople(f, (x) => [x.sub.b?.[0], x.sub.a?.[0]].filter(Boolean).join(' '));
    people.creators.push(...['710', '711'].flatMap((t) => (f[t] ?? []).map((x) => x.sub.a?.[0]).filter(Boolean)));
    return {
      source: 'Bibliothèque nationale de France', catalogued: true, key: `bnf:${ark}`,
      url: ark, recordLabel: `BnF catalogue record ${ark.split('/').pop()}`,
      // Older records run on into the statement of responsibility: "…, par Diabate Boubacar,... [Préface par …".
      title: trimPunct(sf(f, '200', 'a')[0]?.replace(/,\s+par\s+[^[]*?,\.\.\..*$/i, '')), subtitle: trimPunct(sf(f, '200', 'e')[0]) || undefined,
      ...withPeople(people, (translated) => unimarcOriginal(f, translated)),
      // "Impr. spéciale du bureau d'éditions ; Bureau d'éditions" names two bodies.
      publishers: sf(f, imprint, 'c').flatMap((p) => p.split(/\s;\s/)).map(expandImprint),
      publish_places: sf(f, imprint, 'a').map(trimPunct),
      // Field 100 carries the coded publication date at positions 9–12.
      publish_date: sf(f, imprint, 'd')[0] || sf(f, '100', 'a')[0]?.slice(9, 13).replace(/\D/g, '') || '',
      languageNames: sf(f, '101', 'a'),
      // A Gallica copy, when the BnF has digitised the book; whether it is open is checked later.
      digital: sf(f, '856', 'u').find((u) => /gallica\.bnf\.fr\/ark:/.test(u))?.replace(/^http:/, 'https:'),
    };
  }).filter((r) => r.title);
}

/**
 * National Diet Library Search records whose publisher matches a term (in Japanese script),
 * optionally limited to publication years. A query returns at most 500 records, so large houses
 * are searched year by year. Only the NDL's own catalogue (dpid=iss-ndl-opac) is searched: its
 * records may be reused with credit, compatibly with CC BY 4.0, while NDL Search's other providers
 * set their own terms (some non-commercial).
 */
export async function ndlRecords(term, from, until, param = 'publisher') {
  const years = (from ? `&from=${from}` : '') + (until ? `&until=${until}` : '');
  const items = [];
  for (let idx = 1; idx <= (param === 'publisher' ? 5000 : 400); idx += 200) {
    const xml = await getText(`https://ndlsearch.ndl.go.jp/api/opensearch?dpid=iss-ndl-opac&${param}=${encodeURIComponent(term)}${years}&cnt=200&idx=${idx}`);
    if (!xml) break;
    const found = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
    for (const it of found) {
      const tag = (t) => [...it.matchAll(new RegExp(`<${t}(?:\\s[^>]*)?>([\\s\\S]*?)</${t}>`, 'g'))].map((m) => xmlText(m[1]));
      const url = tag('guid')[0] ?? tag('link')[0];
      const category = tag('category');
      if (category.length && !category.includes('図書')) continue; // books only
      items.push({
        source: 'National Diet Library', catalogued: true, key: `ndl:${url}`,
        url, recordLabel: `National Diet Library Search record ${String(url).split('/').pop()}`,
        title: tag('dc:title')[0],
        creators: tag('dc:creator').map((c) => c.replace(/\s*[,，]?\s*\d{4}-(\d{4})?$/, '')),
        publishers: tag('dc:publisher'),
        publish_places: [],
        publish_country: tag('dcndl:publicationPlace')[0] === 'JP' ? 'ja' : '',
        publish_date: tag('dc:date')[0] ?? '',
        languageNames: ['jpn'],
        // A copy in the NDL Digital Collections; whether it is open is checked later.
        digital: it.match(/dl\.ndl\.go\.jp\/pid\/\d+/)?.[0].replace(/^/, 'https://'),
      });
    }
    const total = Number((xml.match(/<openSearch:totalResults>(\d+)</) ?? [])[1] ?? 0);
    if (!found.length || idx + 200 > total) break;
  }
  return items.filter((r) => r.title);
}

// ---------------------------------------------------------------------------
// CiNii Books
// ---------------------------------------------------------------------------

/**
 * CiNii Books, the union catalogue of Japanese university libraries, which hold much of the
 * English, Russian, Chinese and German left press. Its open search finds records by publisher;
 * each item carries only its title, statement of responsibility, publisher and year, so the full
 * record (language, series, LCCN, authors) is fetched separately, and only for titles the catalogue
 * lacks (see ciniiRecord).
 */
/** How many records CiNii Books finds for a publisher term. */
export async function ciniiTotal(term) {
  const text = await getText(`https://ci.nii.ac.jp/books/opensearch/search?publisher=${encodeURIComponent(term)}&format=json&count=1`);
  try { return Number(JSON.parse(text)['@graph'][0]['opensearch:totalResults']) || 0; } catch { return 0; }
}

export async function ciniiSearch(term, param = 'publisher', year) {
  const items = [];
  // A year splits a large house's list into searches under the 5,000-record cap.
  const years = year ? `&year_from=${year}&year_to=${year}` : '';
  for (let page = 1; page <= (param === 'publisher' ? 25 : 2); page++) {
    const text = await getText(`https://ci.nii.ac.jp/books/opensearch/search?${param}=${encodeURIComponent(term)}&format=json&count=200&p=${page}${years}`);
    let graph;
    try { graph = JSON.parse(text)['@graph'][0]; } catch { break; }
    const got = graph.items ?? [];
    for (const it of got) {
      const publishers = [].concat(it['dc:publisher'] ?? []).filter(Boolean);
      items.push({
        ncid: String(it['@id']).split('/').pop(), title: it.title, statement: it['dc:creator'],
        publishers, year: Number(String(it['dc:date'] ?? it['prism:publicationDate'] ?? '').match(/\d{4}/)?.[0]) || undefined,
      });
    }
    if (got.length < 200 || items.length >= Number(graph['opensearch:totalResults'] ?? 0)) break;
  }
  return items;
}

const asArray = (x) => (Array.isArray(x) ? x : x == null ? [] : [x]);
const valueOf = (x) => (x && typeof x === 'object' ? x['@value'] ?? x['dc:title'] ?? x['@id'] : x);

/** The full record of a CiNii Books search item, as an edition-like record. */
export async function ciniiRecord(item) {
  const text = await getText(`https://ci.nii.ac.jp/ncid/${item.ncid}.json`);
  let g;
  try { g = JSON.parse(text)['@graph'][0]; } catch { return null; }
  const [title, subtitle] = String(valueOf(asArray(g['dc:title'])[0]) ?? item.title).split(/\s+:\s+/);
  const lccn = valueOf(asArray(g['bibo:lccn'])[0]);
  // "New world paperbacks, 0614-6": the series and its number.
  const series = asArray(g['dcterms:isPartOf']).map((x) => valueOf(asArray(x['dc:title'])[0] ?? x)).find(Boolean);
  return {
    source: 'CiNii Books', catalogued: true, key: `cinii:${item.ncid}`,
    url: `https://ci.nii.ac.jp/ncid/${item.ncid}`, recordLabel: `CiNii Books record ${item.ncid}`,
    title: trimPunct(title), subtitle: trimPunct(subtitle) || undefined, series: series ? trimPunct(series) : undefined,
    creators: asArray(g['foaf:maker']).map((m) => valueOf(asArray(m['foaf:name'])[0])).filter(Boolean),
    publishers: asArray(g['dc:publisher']).map(valueOf).filter(Boolean),
    publish_places: [],
    publish_date: String(valueOf(asArray(g['prism:publicationDate'])[0]) ?? valueOf(g['dc:date']) ?? item.year ?? ''),
    languageNames: asArray(g['dc:language']).map(valueOf).filter((c) => /^[a-z]{3}$/.test(c ?? '')),
    lccn,
  };
}

// ---------------------------------------------------------------------------
// SUDOC (French university libraries) and swisscovery (Swiss libraries)
// ---------------------------------------------------------------------------

/**
 * SUDOC, the union catalogue of French university and research libraries, searched by its
 * publisher (edi) index. Its records are UNIMARC: title 200, imprint 210 or 214, authors 700–702,
 * language 101, series 225.
 */
export async function sudocRecords(term, index = 'edi', year) {
  // A year (the apu index) splits a large house's list into searches under the 3,000-record cap.
  const query = `${index}="${term}"${year ? ` and apu=${year}` : ''}`;
  const xmls = await sruRecords('https://www.sudoc.abes.fr/cbs/sru/', query, 'unimarc', 100, index === 'edi' ? 30 : 2);
  return xmls.map((xml) => {
    const f = marcFields(xml);
    const id = f['001']?.[0]?.value;
    // Publication fields only: 214 with second indicator 0 or 1 (not printing, 3), else 210.
    const pub = [...(f['214'] ?? []).filter((x) => x.ind2 === '0' || x.ind2 === '1'), ...(f['210'] ?? [])];
    const pf = (code) => pub.flatMap((x) => x.sub?.[code] ?? []);
    const coded = f['100']?.[0]?.sub?.a?.[0]?.slice(9, 13);
    const people = unimarcPeople(f, (x) => [x.sub?.a?.[0], x.sub?.b?.[0]].filter(Boolean).join(', '));
    people.creators.push(...sf(f, '710', 'a'));
    return {
      source: 'SUDOC', catalogued: true, key: `sudoc:${id}`,
      url: `https://www.sudoc.fr/${id}`, recordLabel: `SUDOC record ${id}`,
      title: trimPunct(sf(f, '200', 'a')[0]), subtitle: trimPunct(sf(f, '200', 'e')[0]) || undefined,
      series: [sf(f, '225', 'a')[0], sf(f, '225', 'v')[0]].filter(Boolean).join(' ; ') || undefined,
      ...withPeople(people, (translated) => unimarcOriginal(f, translated)),
      publishers: pf('c').map(trimPunct).filter(Boolean),
      publish_places: pf('a').map(trimPunct).filter((p) => !/inconnu/i.test(p)),
      publish_date: pf('d').find((d) => /\d{4}/.test(d)) ?? (/^\d{4}$/.test(coded ?? '') ? coded : ''),
      languageNames: sf(f, '101', 'a'),
    };
  }).filter((r) => r.title && r.publishers.length);
}

/** swisscovery, the network of Swiss academic libraries (MARC 21), searched by publisher. */
export async function swissRecords(term, index = 'alma.publisher') {
  const xmls = await sruRecords('https://swisscovery.slsp.ch/view/sru/41SLSP_NETWORK', `${index}="${term}"`, 'marcxml', 50, index === 'alma.publisher' ? 20 : 2);
  return xmls.map((xml) => {
    const f = marcFields(xml);
    const id = f['001']?.[0]?.value;
    const imprint = (f['264'] ?? []).find((x) => x.ind2 === '1') ? '264' : '260';
    const f008 = f['008']?.[0]?.value ?? '';
    return {
      source: 'swisscovery', catalogued: true, key: `swiss:${id}`,
      url: `https://swisscovery.slsp.ch/discovery/fulldisplay?docid=alma${id}&vid=41SLSP_NETWORK:VU1_UNION`, recordLabel: `swisscovery record ${id}`,
      title: trimPunct(sf(f, '245', 'a')[0]), subtitle: trimPunct(sf(f, '245', 'b')[0]) || undefined,
      series: [sf(f, '490', 'a')[0], sf(f, '490', 'v')[0]].filter(Boolean).map(trimPunct).join(' ; ') || undefined,
      ...withPeople(marc21People(f), (translated) => marc21Original(f, translated)),
      publishers: sf(f, imprint, 'b').map(expandImprint),
      publish_places: sf(f, imprint, 'a').map(trimPunct),
      publish_date: sf(f, imprint, 'c')[0] ?? f008.slice(7, 11), coded_year: f008.slice(7, 11),
      languageNames: sf(f, '041', 'a').length ? sf(f, '041', 'a') : [f008.slice(35, 38)].filter((c) => /^[a-z]{3}$/.test(c)),
    };
  }).filter((r) => r.title && r.publishers.length);
}

/** A MARC 21 record from one of the union and national catalogues below, in the import's shape. */
function marc21Record(xml, source, key, url) {
  const f = marcFields(xml);
  const id = f['001']?.[0]?.value;
  const imprint = (f['264'] ?? []).find((x) => x.ind2 === '1') ? '264' : '260';
  const f008 = f['008']?.[0]?.value ?? '';
  return {
    source, catalogued: true, key: `${key}:${id}`, url: url(id), recordLabel: `${source} record ${id}`,
    title: trimPunct(sf(f, '245', 'a')[0]), subtitle: trimPunct(sf(f, '245', 'b')[0]) || undefined,
    series: [sf(f, '490', 'a')[0], sf(f, '490', 'v')[0]].filter(Boolean).map(trimPunct).join(' ; ') || undefined,
    ...withPeople(marc21People(f), (translated) => marc21Original(f, translated)),
    publishers: sf(f, imprint, 'b').map(expandImprint),
    publish_places: sf(f, imprint, 'a').map(trimPunct),
    publish_date: sf(f, imprint, 'c')[0] ?? f008.slice(7, 11), coded_year: f008.slice(7, 11),
    languageNames: sf(f, '041', 'a').length ? sf(f, '041', 'a') : [f008.slice(35, 38)].filter((c) => /^[a-z]{3}$/.test(c)),
  };
}

/**
 * K10plus, the union catalogue of northern and south-western German libraries, searched by publisher
 * (pica.vlg). It holds the Berlin State Library's Slavic, East European and East Asian collections.
 */
export async function k10plusRecords(term, year) {
  // A year (the jah index) splits a large house's list into smaller searches.
  const query = `pica.vlg="${term}"${year ? ` and pica.jah=${year}` : ''}`;
  const xmls = await sruRecords('https://sru.k10plus.de/opac-de-627', query, 'marcxml', 100, 100);
  return xmls.map((xml) => marc21Record(xml, 'K10plus', 'k10plus', (id) => `https://kxp.k10plus.de/DB=2.1/PPNSET?PPN=${id}`))
    .filter((r) => r.title && r.publishers.length);
}

/**
 * B3Kat, the union catalogue of Bavarian and Berlin-Brandenburg libraries, among them the Bavarian
 * State Library's East European collections. Its SRU service has no publisher index, so a term is
 * searched as keywords and the import's publisher rules decide which records belong to which house.
 */
export async function b3katRecords(term, year) {
  const query = `"${term}"${year ? ` and marcxml.date=${year}` : ''}`;
  const xmls = await sruRecords('http://bvbr.bib-bvb.de:5661/bvb01sru', query, 'marcxml', 100, 50);
  return xmls.map((xml) => marc21Record(xml, 'B3Kat', 'b3kat', (id) => `https://www.gateway-bayern.de/${id}`))
    .filter((r) => r.title && r.publishers.length);
}

/** The Biblioteca Nacional de España (MARC 21), searched by publisher. */
export async function bneRecords(term, year) {
  const query = `alma.publisher="${term}"${year ? ` and alma.main_pub_date=${year}` : ''}`;
  const xmls = await sruRecords('https://catalogo.bne.es/view/sru/34BNE_INST', query, 'marcxml', 50, 40);
  return xmls.map((xml) => marc21Record(xml, 'Biblioteca Nacional de España', 'bne',
    (id) => `https://catalogo.bne.es/discovery/fulldisplay?docid=alma${id}&vid=34BNE_INST:CATALOGO`))
    .filter((r) => r.title && r.publishers.length);
}

/** The number of records a catalogue holds for a search, so a large house can be searched year by year. */
async function sruCount(base, query, version = '1.1') {
  const xml = await getText(`${base}?version=${version}&operation=searchRetrieve&query=${encodeURIComponent(query)}&maximumRecords=0`);
  return Number((xml.match(/<(?:\w+:)?numberOfRecords>(\d+)</) ?? [])[1] ?? 0);
}
export const k10plusCount = (term) => sruCount('https://sru.k10plus.de/opac-de-627', `pica.vlg="${term}"`);
export const b3katCount = (term) => sruCount('http://bvbr.bib-bvb.de:5661/bvb01sru', `"${term}"`);
export const bneCount = (term) => sruCount('https://catalogo.bne.es/view/sru/34BNE_INST', `alma.publisher="${term}"`, '1.2');

/**
 * The HathiTrust Hathifiles: the monthly tab-separated listing of every item in HathiTrust, read
 * from .cache/hathifiles as a stream, in batches of records grouped by catalogue record (an item
 * is one volume). `wanted(imprint)` is a quick first filter on the publisher's words, so the
 * house rules judge only likely records of the eighteen million. Its imprints carry no place, only
 * the record's MARC country code, which the rules check instead. A record HathiTrust opens to
 * readers everywhere (public domain or Creative Commons) carries a link to its full view.
 */
export async function* hathiRecords(wanted, batchSize = 2000) {
  const { readdirSync, createReadStream } = await import('node:fs');
  const { createGunzip } = await import('node:zlib');
  const { createInterface } = await import('node:readline');
  const dir = join(ROOT, '.cache', 'hathifiles');
  const file = existsSync(dir) && readdirSync(dir).filter((f) => /^hathi_full_\d+\.txt\.gz$/.test(f)).sort().at(-1);
  if (!file) return;
  const OPEN = /^(pd|cc-)/; // "pdus" is open only in the United States
  let batch = [];
  let current;
  const finish = () => {
    if (current) batch.push(current);
    current = undefined;
  };
  const lines = createInterface({ input: createReadStream(join(dir, file)).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) {
    const f = line.split('\t');
    const [htid, , rights, bibKey] = f;
    if (current?.bibKey === bibKey) {
      if (!current.digital && OPEN.test(rights)) current.digital = `https://hdl.handle.net/2027/${htid}`;
      continue;
    }
    finish();
    if (batch.length >= batchSize) { yield batch; batch = []; }
    const imprint = f[12] ?? '';
    if (f[19] !== 'BK' || !wanted(imprint)) continue;
    // "International Publishers, [1970, c1960]": the publisher, without the date.
    const publisher = imprint.replace(/[,;:\s]*\[?(c|cop\.|ca\.)?\s*\d{4}.*$/i, '').replace(/[,;:\s]+$/, '').trim();
    if (!publisher) continue;
    // "Reminiscences of Lenin / by N. K. Krupskaya. [Translated …": the title without its statement of responsibility.
    const [title, subtitle] = f[11].replace(/\s+\/\s.*$/, '').replace(/[\s.]+$/, '').split(/\s*[;:]\s+/);
    const year = /^\d{4}$/.test(f[16]) && f[16] !== '9999' ? f[16] : (imprint.match(/\b(1[5-9]|20)\d\d\b/) ?? [])[0];
    const oclc = (f[7] ?? '').split(',')[0] || undefined;
    current = {
      bibKey, source: 'HathiTrust', catalogued: true, key: `hathi:${bibKey}`,
      url: `https://catalog.hathitrust.org/Record/${bibKey}`, recordLabel: `HathiTrust record ${bibKey}`,
      title, subtitle,
      creators: f[25] ? [f[25].replace(/,\s*(\d{4}-?(\d{4})?\.?|\d{4}-)?\s*$/, '').trim()] : [],
      publishers: [expandImprint(publisher)], publish_places: [], publish_country: (f[17] ?? '').trim(),
      publish_date: year, languageNames: [f[18]].filter(Boolean), oclc,
      digital: OPEN.test(rights) ? `https://hdl.handle.net/2027/${htid}` : undefined,
    };
  }
  finish();
  if (batch.length) yield batch;
}
