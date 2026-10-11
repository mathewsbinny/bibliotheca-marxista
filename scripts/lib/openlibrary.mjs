/**
 * Shared Open Library helpers for the import and verification scripts.
 * API responses are cached in .cache/openlibrary so re-runs are fast and polite.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ROOT = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
export const OL = 'https://openlibrary.org';

/**
 * Hosts to treat as unreachable (--offline=archive.org, read into LEFT_BACKLIST_OFFLINE): their
 * cached responses are still used, but nothing new is requested, so a run can finish while a
 * source is down without losing what it found before.
 */
export const isOffline = (url) =>
  (process.env.LEFT_BACKLIST_OFFLINE ?? '').split(',').filter(Boolean).some((h) => new URL(url).hostname.endsWith(h));

const CACHE = join(ROOT, '.cache', 'openlibrary');
const USER_AGENT = 'left-backlist/0.1 (open bibliographic catalogue of Left publishers)';

// ---------------------------------------------------------------------------
// HTTP with cache, pacing and retries
// ---------------------------------------------------------------------------

mkdirSync(CACHE, { recursive: true });
let lastRequest = 0;
let requests = 0;

export const requestCount = () => requests;

export async function getJSON(url) {
  const file = join(CACHE, createHash('sha1').update(url).digest('hex') + '.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));

  for (let attempt = 1; ; attempt++) {
    const wait = lastRequest + 400 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
    requests++;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (res.ok) {
        const data = await res.json();
        writeFileSync(file, JSON.stringify(data));
        return data;
      }
      if (![429, 500, 502, 503, 504].includes(res.status)) throw new Error(`HTTP ${res.status} ${url}`);
    } catch (err) {
      if (attempt >= 6) throw err;
    }
    if (attempt >= 6) throw new Error(`Giving up on ${url}`);
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

// Note: query.json takes `*=` for "all fields". Listing fields by name with empty values
// (e.g. `publishers=`) silently overrides the filter of the same name.

export async function editionsByPublisher(publisher) {
  const all = [];
  for (let offset = 0; ; offset += 1000) {
    const params = new URLSearchParams({ type: '/type/edition', publishers: publisher, limit: '1000', offset: String(offset), '*': '' });
    const page = await getJSON(`${OL}/query.json?${params}`);
    // Guard against a query that ignores the publisher filter and walks the whole database.
    const onTarget = page.filter((ed) => ed.publishers?.includes(publisher)).length;
    if (page.length && onTarget < page.length * 0.5) {
      console.warn(`  ! skipping imprint ${JSON.stringify(publisher)}: query returned unrelated editions`);
      return all;
    }
    all.push(...page);
    if (page.length < 1000) return all;
  }
}

export async function editionsByWork(workKey) {
  const params = new URLSearchParams({ type: '/type/edition', works: workKey, limit: '1000', '*': '' });
  return getJSON(`${OL}/query.json?${params}`);
}

/** Collects the exact imprint spellings used on Open Library for a loose search term. */
export async function discoverImprints(term, regex) {
  const found = new Set();
  for (let page = 1; page <= 15; page++) {
    const q = `publisher:"${term}"`;
    const res = await getJSON(`${OL}/search.json?q=${encodeURIComponent(q)}&fields=publisher&limit=1000&page=${page}`);
    // Match on the composed form, but keep the spelling as stored: edition queries need it exactly.
    for (const doc of res.docs) for (const p of doc.publisher ?? []) if (regex.test(p.trim().normalize('NFC'))) found.add(p);
    if (page * 1000 >= res.numFound) break;
  }
  return found;
}

/** Every edition of the works matching a title (and, optionally, an author's surname). */
export async function editionsForTitle(title, author) {
  const q = [`title:"${title.replace(/"/g, '')}"`, author ? `author:${surname(author)}` : ''].filter(Boolean).join(' ');
  const res = await getJSON(`${OL}/search.json?q=${encodeURIComponent(q)}&fields=key&limit=5`);
  const editions = [];
  for (const doc of res.docs) editions.push(...(await editionsByWork(doc.key)));
  return editions;
}

/** Work-level author names, keyed by work key ("/works/OL…W"). */
export const workAuthors = new Map();

/** Fetches the author names Open Library records on works, 50 at a time. */
export async function resolveWorkAuthors(workKeys) {
  const missing = [...new Set(workKeys)].filter((k) => !workAuthors.has(k));
  for (let i = 0; i < missing.length; i += 50) {
    const batch = missing.slice(i, i + 50);
    const q = `key:(${batch.map((k) => `"${k}"`).join(' OR ')})`;
    const res = await getJSON(`${OL}/search.json?q=${encodeURIComponent(q)}&fields=key,author_name&limit=100`);
    for (const d of res.docs) workAuthors.set(d.key, d.author_name ?? []);
    for (const k of batch) if (!workAuthors.has(k)) workAuthors.set(k, []);
  }
}

export const authorNames = new Map();
/** Other spellings recorded for each author (fuller forms, other scripts). */
export const authorAlternates = new Map();

export async function resolveAuthors(keys) {
  const missing = [...new Set(keys)].filter((k) => !authorNames.has(k));
  for (let i = 0; i < missing.length; i += 50) {
    const batch = missing.slice(i, i + 50);
    const q = `key:(${batch.map((k) => `"${k}"`).join(' OR ')})`;
    const res = await getJSON(`${OL}/search/authors.json?q=${encodeURIComponent(q)}&fields=key,name,alternate_names&limit=100`);
    for (const d of res.docs) {
      const key = `/authors/${d.key.replace(/^\/authors\//, '')}`;
      authorNames.set(key, d.name);
      authorAlternates.set(key, d.alternate_names ?? []);
    }
    for (const k of batch) if (!authorNames.has(k)) authorNames.set(k, null);
  }
}

// ---------------------------------------------------------------------------
// Normalisation and matching
// ---------------------------------------------------------------------------

export const clean = (s) =>
  s == null ? undefined
    : String(s).replace(/\s+/g, ' ').replace(/\s*[\/:;,=]\s*$/, '').replace(/(?<=[a-z\d\)\]])\.$/, '').trim() || undefined;

/**
 * Lower-case words for comparison, in any script: Latin accents are dropped ("Lénine" = "Lenine"),
 * while Chinese, Japanese, Cyrillic, Arabic and other letters are kept, recomposed so that kana
 * voicing marks and Indic vowel signs stay part of their words.
 */
export const slug = (s) =>
  String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();

export function surname(name) {
  return slug(name).split(' ').filter((w) => w.length > 1).pop() ?? '';
}

export function yearOf(date) {
  const m = String(date ?? '').match(/1[89]\d\d|20[0-3]\d/);
  return m ? Number(m[0]) : undefined;
}

/** True when the record was derived from a library catalogue rather than entered by hand. */
export function isCatalogued(ed) {
  return Boolean(ed.oclc_numbers?.length || ed.lccn?.length || ed.source_records?.some((s) => /^(marc|ia):/.test(s)));
}

/** Loose title match between a known title and a catalogue record. */
export function titlesMatch(known, rec) {
  const a = slug(known.title);
  const b = slug(rec.title);
  const bFull = slug(`${rec.title} ${rec.subtitle ?? ''}`);
  return a === b || a === bFull || (a.length > 12 && (b.startsWith(a) || a.startsWith(b)));
}

// ---------------------------------------------------------------------------
// Title capitalisation
// ---------------------------------------------------------------------------

// Articles, conjunctions and prepositions left lower-case inside English titles (Chicago style).
const MINOR_WORDS = new Set(
  'a an the and but or nor for so yet as at by in of off on per to up via vs v from into onto upon with over than'.split(' '),
);
// Name particles kept lower-case when already lower-case, e.g. "Leonardo da Vinci".
const PARTICLES = new Set('de da del della di du van von der den la le'.split(' '));
// Library "general material designations" that are not part of the title.
const GMD = /\s*\[(microform|electronic resource|microfiche|microfilm|sound recording|videorecording|text|print)\]/gi;

// Restored after lower-casing an ALL-CAPS record.
const ACRONYMS = new Set(
  'USSR USA US UK UN UNESCO NATO SEATO CPSU CPGB CPUSA CPC PRC DPRK DRV GDR FRG CIA FBI KGB AFL CIO TUC ANC SWAPO PLO NLF ILO WFTU'.split(' '),
);
// Roman numerals up to XXXIX; "li", "xi", "mix" etc. are words or names, not numerals.
const ROMAN = /^(?=[ivx]+$)x{0,3}(ix|iv|v?i{0,3})$/;

const capitaliseFirst = (w) => w.replace(/^([^\p{L}\p{N}]*)(\p{Ll})/u, (_, pre, c) => pre + c.toUpperCase());
const isAcronym = (w) => /\p{L}/u.test(w) && w.replace(/[^\p{L}]/gu, '').length > 1 && w === w.toUpperCase();

// Prefixes whose hyphenated second element stays lower-case in title case: "Anti-imperialism".
const PREFIXES = new Set('anti pre post non co re sub semi pro multi inter intra ultra neo counter extra mid'.split(' '));

// A Chinese or Korean romanised syllable (Wade–Giles, pinyin, McCune–Reischauer). Hyphenated given
// names keep their second syllable lower-case: "Mao Tse-tung", "Chou En-lai", "Kim Il-sung".
const SYLLABLE =
  /^(ch|hs|sh|ts|tz|ss|k|p|t|j|l|m|n|f|h|y|w|s|g|z|c|q|x|b|d|r)?['’]?(a|ai|an|ang|ao|e|ei|en|eng|erh|eh|i|ia|iang|iao|ieh|ien|in|ing|iu|iung|o|ong|ou|u|ua|uai|uan|uang|ui|un|ung|uo|ü|üeh|ueh|uen|uei|üan|ün|ih|ŭ|ŏ|ê|zu|ze|zû|u|yu|yung|ŭi|ae|oe|wi|wa|we|wŏ|yŏ|yo|ya|il|ol|ul|ŏl|ŭl|ok|ak|uk|ik|ŏk|ap|op|ip|am|im|um|ŏm|at|it|ut|on|ŏn|ŭn|inh|anh|ung)$/i;
const isNameSyllables = (first, second) => SYLLABLE.test(first) && SYLLABLE.test(second.replace(/['’]s$/, ''));
// Arabic article and particles in transliteration: "al-Marjan", "Dar el-Tahrir", "wa-al-Taʻawun".
const ARABIC_PARTICLES = new Set('al el wa wal bi li fi ka ad an ar as at az ash ath ud ul ibn bin bint abu umm'.split(' '));
// Transliterated Russian, Serbo-Croatian and similar titles mislabelled as English keep their own casing.
const TRANSLITERATION = /[ĭʹʺšžčćőűřěůŭŏ]|\p{L}{3,}(aya|skie|skii|nykh|ogo|ikh|sii|tii)\b/u;
// Korean place-name suffixes, lower-case after a hyphen: "Chongsan-ri", "Kumgang-san".
const PLACE_SUFFIXES = new Set('ri ni li san dong gun do gu ku si up ŭp myon myŏn'.split(' '));

/** Chicago capitalises each element of a compound: "Five-Year Plan", "Wage-Labour", but "Anti-fascist". */
const capitaliseCompound = (w) =>
  /^[^\p{L}]*\p{Ll}/u.test(w) || /['’]\p{L}*-/u.test(w) ? w : // "al-Fatah", "Qu'est-ce"
  w
    // Acronyms of three letters or more inside a compound: "Ussr-usa" → "USSR-USA".
    .replace(/\p{L}+/gu, (part) => (/-/.test(w) && part.length > 2 && ACRONYMS.has(part.toUpperCase()) ? part.toUpperCase() : part))
    .replace(/(?<=(\p{L}+))-(\p{L}[\p{L}'’]*)/gu, (m, first, second) => {
    const core = second.replace(/['’]s$/, '');
    if (!/^\p{Ll}/u.test(second)) return m;
    if (ROMAN.test(core) && core.length > 1) return `-${second.replace(core, core.toUpperCase())}`; // "Vol-II"
    const keep =
      PREFIXES.has(first.toLowerCase()) || MINOR_WORDS.has(first.toLowerCase()) || MINOR_WORDS.has(core.toLowerCase()) ||
      ARABIC_PARTICLES.has(first.toLowerCase()) || ARABIC_PARTICLES.has(core.toLowerCase()) || /^(th|st|nd|rd)$/.test(core) ||
      isNameSyllables(first, second) || PLACE_SUFFIXES.has(core);
    return keep ? m : `-${second[0].toUpperCase()}${second.slice(1)}`;
  });

// Words after which a capitalised "US" is the pronoun, not the United States: "Let Us Unite".
const US_PRONOUN_AFTER = new Set(
  'let help for of to with between and from by among unite join give tell show save teach leave lead about upon before behind around toward towards like unto beside defend love hear need call against'.split(' '),
);

const COUNTRIES = new Set(
  'korea china japan cuba vietnam ussr russia europe india iran iraq israel britain france germany nicaragua panama mexico canada africa asia america philippines'.split(' '),
);

/** "Help US in the Fight" → "Help Us in the Fight", leaving "US Aggression" and "Soviet-US" alone. */
export function fixUsPronoun(title) {
  const parts = title.split(/(\s+)/);
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i].match(/^US([,:;!?.)]*)$/);
    if (!m) continue;
    const prev = (parts[i - 2] ?? '').replace(/[^\p{L}]/gu, '').toLowerCase();
    const next = (parts[i + 2] ?? '').replace(/[^\p{L}]/gu, '').toLowerCase();
    const endsPhrase = m[1] !== '' || i === parts.length - 1 || next === '';
    // "Between Korea and US" and "US and Other NATO Countries" mean the United States.
    const beforeAnd = (parts[i - 4] ?? '').replace(/[^\p{L}]/gu, '').toLowerCase();
    if (next === 'and' || (prev === 'and' && COUNTRIES.has(beforeAnd))) continue;
    if (prev === 'let' || (US_PRONOUN_AFTER.has(prev) && (endsPhrase || MINOR_WORDS.has(next) || ['all', 'both', 'too', 'now'].includes(next)))) {
      parts[i] = 'Us' + m[1];
    }
  }
  return parts.join('');
}

// Articles, prepositions and conjunctions written lower-case inside titles, by language.
const ROMANCE_WORDS = 'de la el en y del los las con por para et le les du des au aux sur dans pour di e il della dello delle nel nella da do dos das em no na nos nas com um uma o os as a al una un une ou sobre entre ed';
const MINOR_BY_LANGUAGE = Object.fromEntries(
  [
    [['Spanish', 'French', 'Italian', 'Portuguese', 'Catalan', 'Galician'], ROMANCE_WORDS],
    // German capitalises its nouns, so only these small words are changed.
    [['German'], 'und der die das des dem den im in zur zum von vom mit für zu aus auf an am bei nach über unter vor oder als'],
    // Not "i": a capital I in Polish titles is usually a Roman numeral ("I Sekretarz", "31 I 1974").
    [['Polish'], 'w z na do o od dla po za ze we oraz'],
    [['Czech'], 'a v ve z ze na do o od pro po za s se k'],
    [['Slovak'], 'a v vo z zo na do o od pre po za s so k'],
    [['Hungarian'], 'és a az'],
    [['Romanian'], 'și si de la în in cu pe din pentru al ale'],
  ].flatMap(([langs, words]) => langs.map((l) => [l, new Set(words.split(' '))])),
);

/**
 * Library records in other languages are already in sentence case, but bookseller records are often
 * cased like English: "Historia De La Educacion En La Antigüedad", "Resolutionen Zu Grundfragen Des
 * Internationalen Handels". Where a title has two or more capitalised articles, prepositions or
 * conjunctions inside a phrase, they are lower-cased; nouns are left alone, since they may be names.
 */
export function recaseForeign(title, language) {
  // A multilingual edition's title is in its first language: "German, English, French".
  const primary = String(language ?? '').split(', ')[0];
  if (primary === 'Turkish') return title.replace(/(?<=\S\s)Ve(?=\s)/g, 've');
  const minor = MINOR_BY_LANGUAGE[primary];
  if (!minor) return title;
  const parts = title.split(/(\s+)/);
  const candidates = [];
  let startOfPhrase = true;
  for (let i = 0; i < parts.length; i++) {
    const w = parts[i];
    if (!/\S/.test(w)) continue;
    if (!startOfPhrase && /^\p{Lu}\p{Ll}*$/u.test(w) && minor.has(w.toLowerCase())) candidates.push(i);
    // A semicolon or "[and]" joins separate titles in old records: "…1910; Nach d. stenogr. Berichten".
    startOfPhrase = /[:;!?.—–/(\[\]]$/.test(w) || /^[—–-]$/.test(w);
  }
  if (candidates.length < 2) return title;
  for (const i of candidates) parts[i] = parts[i].toLowerCase();
  return parts.join('');
}

/** Corrections that are safe to apply again to an already formatted title. */
export function tidyCase(title, language) {
  if (!title) return title;
  // The first language listed is the title's; "German, English" gets the German rules.
  const primary = String(language ?? '').split(', ')[0];
  if (primary === 'English' || ((language ?? '').includes('English') && !MINOR_BY_LANGUAGE[primary] && primary !== 'Turkish')) {
    const compounds = !TRANSLITERATION.test(title);
    return fixUsPronoun(
      title
        .split(/(\s+)/)
        .map((w) => (compounds && /^\p{Lu}/u.test(w) ? capitaliseCompound(w) : w).replace(/^Mc(\p{Ll})(?=\p{Ll})/u, (_, c) => 'Mc' + c.toUpperCase()))
        .join(''),
    );
  }
  return recaseForeign(title, language);
}

/** English title case: "the struggle for new China" → "The Struggle for New China". */
export function titleCase(text) {
  let s = text;
  const letters = s.replace(/[^\p{L}]/gu, '');
  if (letters.length > 3 && letters === letters.toUpperCase()) s = s.toLowerCase(); // ALL-CAPS records
  const parts = s.split(/(\s+)/);
  const wordIdx = parts.flatMap((p, i) => (/\S/.test(p) ? [i] : []));
  const last = wordIdx.at(-1);
  let startOfPhrase = true;
  let previous = '';
  return parts
    .map((w, i) => {
      if (!/\S/.test(w)) return w;
      const core = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
      const forced = startOfPhrase || i === last;
      // A full stop ends a phrase, but not in abbreviations such as "U.S.A." or "Vol."
      const sentenceStop = /\.$/.test(w) && (w.match(/\./g) ?? []).length === 1 && core.length > 3;
      startOfPhrase = /[:!?—–]$/.test(w) || sentenceStop || /^[—–-]$/.test(w);
      const afterNumbering = /^(vol|volume|part|book|no|tome|t)\.?$/i.test(previous);
      previous = core;
      if (isAcronym(w)) return w;
      if (ACRONYMS.has(core.toUpperCase())) return w.replace(new RegExp(core, 'i'), core.toUpperCase());
      if (ROMAN.test(core) && (afterNumbering || (core.length > 1 && core !== 'xi'))) {
        return w.replace(new RegExp(core, 'i'), core.toUpperCase());
      }
      if (!forced && MINOR_WORDS.has(core)) return w.toLowerCase();
      if (!forced && PARTICLES.has(core) && w === w.toLowerCase()) return w;
      return capitaliseFirst(w);
    })
    .join('');
}

// Function words that mark a title's language; none of them is also an English word.
const FOREIGN_WORDS = {
  French: 'le la les des du et sur dans pour une au aux est qui que pas ou par à avec ces sont entre l',
  Spanish: 'el la los las del y en por para con una sobre como se al hacia desde entre sin',
  German: 'der die das und des den dem im zur zum von mit für auf über ein eine ist aus zu bei nach vom wie gegen unser unsere sind',
  Italian: 'il la lo gli le della delle dei degli di e per con una nel nella sul',
  Portuguese: 'os das dos da em na para com uma',
};
const ENGLISH_WORDS = new Set('the of and to for with from by an is at'.split(' '));

/**
 * The language of a title catalogued as English but written in another: two or more of that
 * language's function words and no English ones ("La Verdad de Las Relaciones Entre Vietnam Y China").
 */
export function foreignTitleLanguage(title) {
  const words = String(title ?? '').toLowerCase().split(/[\s'’]+/).map((w) => w.replace(/[^\p{L}]/gu, ''));
  if (words.some((w) => ENGLISH_WORDS.has(w))) return undefined;
  // Romanised Russian: its prepositions, or two or more words with Russian case endings.
  const russianEndings = words.filter((w) => /(ogo|ykh|ikh|nyi|nyy|nyĭ|skoi|skoĭ|skoy|skii|skiĭ|iia|iya|nosti|stva|aniia|aniya|enie|enii|ovanie)$/.test(w)).length;
  const russianWords = words.filter((w) => /^(v|vo|na|po|ob|iz|ot|dlia|dlya|pri|pod|nad|ili|kak|i|o|k|s)$/.test(w)).length;
  if (russianEndings >= 2 && russianWords + russianEndings >= 3) return 'Russian';
  let best;
  let most = 1;
  for (const [language, list] of Object.entries(FOREIGN_WORDS)) {
    const set = new Set(list.split(' '));
    const n = words.filter((w) => set.has(w)).length;
    if (n > most) { most = n; best = language; }
  }
  return best;
}

/** True for titles that should be English title-cased. */
export function isEnglishTitle(title, language) {
  const langs = language ? language.split(', ') : [];
  if (langs.includes('English')) return !(langs.length === 1 && foreignTitleLanguage(title));
  if (langs.length && !langs.includes('Multiple languages')) return false;
  return /\b(the|of|and|to|for|with|on)\b/i.test(title) && !/\b(de|la|le|les|des|und|der|die|das|el|los|las|y|del)\b/i.test(title);
}

/** Tidies a catalogue title: drops material designations, then title-cases English or capitalises the first letter. */
export function formatTitle(text, english, language) {
  if (!text) return text;
  // Catalogue (ISBD) spacing "Lenin : a biography" → "Lenin: a biography".
  let s = repairEncoding(text).replace(GMD, '').replace(TIES, '').replace(/\s+([:;,])(?=\s)/g, '$1').trim();
  if (english) return polishTitle(tidyCase(titleCase(s), 'English'), language ?? 'English');
  // ALL-CAPS records in other languages become sentence case, their usual convention.
  const letters = s.replace(/[^\p{L}]/gu, '');
  if (letters.length > 3 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) s = s.toLowerCase();
  return polishTitle(recaseForeign(capitaliseFirst(s), language), language);
}

// Windows-1252 characters in the 0x80–0x9F range, which Latin-1 leaves as control codes.
const CP1252 = new Map([...'€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'].map((c, i) => [c, [0x80, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8e, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9e, 0x9f][i]]));
const MOJIBAKE = /Ã[\u0080-¿‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]|Â[ -¿]|â€/;

/**
 * Text whose UTF-8 bytes were read as Latin-1 or Windows-1252, sometimes twice: "bÃ¼rgerkrieges"
 * → "bürgerkrieges", "stratÃÂ©gies" → "stratégies". Left alone when the bytes do not decode.
 */
export function repairEncoding(s) {
  // Doubly encoded text that lost its control byte: "stratÃÂ©gies".
  let out = String(s).replace(/ÃÂ(?=[ -¿])/g, 'Ã');
  for (let i = 0; i < 2 && MOJIBAKE.test(out); i++) {
    const chars = [...out];
    if (chars.some((c) => c.codePointAt(0) > 0xff && !CP1252.has(c))) break;
    const fixed = Buffer.from(chars.map((c) => CP1252.get(c) ?? c.codePointAt(0))).toString('utf8');
    if (fixed.includes('�')) break;
    out = fixed;
  }
  return out;
}

// Misspellings in English catalogue titles, each checked against the title it came from.
const TITLE_TYPOS = Object.fromEntries(
  `organsation organisation|comunist communist|commmunist communist|eonomic economic|conomic economic|situtation situation
  afica africa|destrucion destruction|pleanary plenary|aggresion aggression|engles engels|rupublics republics
  systwm system|febuary february|februrary february|repubic republic|consturction construction|rasied raised
  developmenmt development|developmnet development|unviersity university|fefty fifty|wiiliam william|willliam william
  chaina china|chna's china's|materalism materialism|coolected collected|problewms problems|captialism capitalism
  capitalsim capitalism|philosphical philosophical|everday everyday|thier their|disarmamant disarmament|soviety soviet
  indsutry industry|czechoslovakiac czechoslovakia|czechoslovakis czechoslovakia|czechoslavakia czechoslovakia
  czechslovakia czechoslovakia|czechloslovakia czechoslovakia|hsitory history|speical special|poeple people|culutre culture
  labout labour|isues issues|welath wealth|internationalsim internationalism|museaum museum|fundamentas fundamentals
  plitical political|abourt about|calss class|ciews views|socalist socialist|bulagarian bulgarian|friedship friendship
  frienship friendship|russsia russia|scence science|hiatorical historical|materiall material|maxism marxism|marxixm marxism
  classsics classics|cinma cinema|crimate climate|goetry poetry|britjsh british|geogrphy geography|potrait portrait
  poetrc poetry|aginst against|nationaism nationalism|imperalism imperialism|globlization globalization
  contemporoary contemporary|peoples's people's|reople's people's|peopel's people's|situtations situations
  deline decline|deartment department|eductation education|commnist communist|comittee committee|committe committee
  revolutionay revolutionary|guerrila guerrilla|mounain mountain|sessison session|consitution constitution
  devlivered delivered|deivered delivered|partiotic patriotic|patrotic patriotic|partriotic patriotic|acadamy academy
  plenun plenum|governmennt government|governmet government|domocratic democratic|officals officials|centural central
  revoltuion revolution|backgroung background|adress address|medecine medicine|mangement management
  equactions equations|difterential differential|explanantory explanatory|imprerialism imperialism|poilitical political
  socalism socialism|revisionsit revisionist|forgotteen forgotten|menance menace|freindship friendship
  communicst communist|necolonialism neocolonialism|cihina's china's|docunents documents|captial capital|trands trends
  achivements achievements|unempolyment unemployment|centernary centenary|reponse response|econogy ecology
  challeng challenge|peacefu peaceful|terrr terror|smalll small|perpspective perspective|commitees committees
  congressses congresses|ammendments amendments|critial critical|miralce miracle|axpansion expansion|dialoque dialogue
  speach speech|pendemic pandemic|communicatrion communication|racdical radical|accounty account|cinspiracy conspiracy
  facist fascist|condision condition|sppeches speeches|trainin training|civlisation civilisation|muscical musical
  positin position|natioal national|intergration integration|exploitaion exploitation|transational transnational
  publlished published|medicial medical|strugle struggle|progess progress|reclaming reclaiming
  activisim activism|vietname vietnam|chinise chinese|reoprt report|agaisnt against|ahich which|grest great|sunmmer summer
  electorial electoral|resistnce resistance|afghanistant afghanistan|afganistan afghanistan|inperialism imperialism
  revolustion revolution|friedrick friedrich|feburary february|eeduction reduction|futher further|disaramament disarmament
  offical official|eidted edited|seventeeth seventeenth|tourtist tourist|turist tourist|assenbly assembly|communst communist
  commedy comedy|isreal israel|demokratic democratic|repablic republic|commitee committee|chrildren children|chariman chairman
  seach search|sturucture structure|guevera guevara|classsic classic|japaniese japanese|coextistence coexistence
  perpective perspective|smystery mystery|nicaragna nicaragua`
    .split(/[|\n]/).map((p) => p.trim().split(' ')),
);
const TITLE_PHRASE_FIXES = [
  [/\bA Singe Spark\b/, 'A Single Spark'], [/\bAnti-Dürhing\b/, 'Anti-Dühring'], [/\bEmpiro-Criticism\b/i, 'Empirio-Criticism'],
  [/\bHitle R\b/, 'Hitler'], [/People'sArmy/, "People's Army"], [/\bMarxism and Poerty \(Sic\)/i, 'Marxism and Poetry'],
  [/\bPerking's\b/, "Peking's"], [/\bRiter and Critic\b/, 'Writer and Critic'], [/\bResurgence of Centra Asia\b/, 'Resurgence of Central Asia'], [/\bBuring Tasks\b/, 'Burning Tasks'], [/\bP Ractical\b/, 'Practical'],
  [/\bBirt of New Chaina\b/, 'Birth of New China'], [/\bthe Partys\b/i, "the Party's"], [/\bEngel's\b/, "Engels'"],
  [/\bSociet Union\b/, 'Soviet Union'], [/\bof Western of Western\b/, 'of Western'], [/\bČzechoslovak\b/, 'Czechoslovak'],
  [/\bMemoirs Jewish Revolutiony-Hb$/, 'Memoirs of a Jewish Revolutionary'], [/-(Hb|Pb)$/, ''],
  [/\bAselection\b/, 'A Selection'], [/\bAtheory\b/, 'A Theory'], [/\bAstory\b/, 'A Story'], [/\bAgreat\b/, 'A Great'],
  [/\bAndother\b/, 'and Other'], [/\bE Xercises\b/, 'Exercises'], [/\bP Olitics\b/, 'Politics'], [/\bVolumeI\b/, 'Volume I'],
  [/\bMr\. Justine\b/, 'Mr. Justice'], [/\bFrenchman's Breek\b/, "Frenchman's Creek"], [/\bAbolition of Whitness\b/, 'Abolition of Whiteness'],
  [/\bCzechoslovakiaTranslated by .*$/, 'Czechoslovakia'], [/\bLabours Challenge\b/, "Labour's Challenge"],
];

// Pre-Unicode umlauts typed as a quote before the vowel: "f"ur" → "für", "Politische "Okonomie".
const UMLAUT = { a: 'ä', o: 'ö', u: 'ü', A: 'Ä', O: 'Ö', U: 'Ü' };
const UMLAUT_LANGUAGES = /^(German|Estonian|Finnish|Hungarian|Swedish|Turkish)/;
// Languages romanised with the hard sign ʺ, which records type as a double quote: "s"ezd" → "sʺezd".
const HARD_SIGN_LANGUAGES = /^(Russian|Belarusian|Ukrainian|Bulgarian|Kazakh|Uzbek|Kyrgyz|Tajik|Turkmen|Azerbaijani|Tatar|Bashkir|Chuvash|Mongolian|Moldavian|Romanian)/;
const OPEN_QUOTES = /["“„«]/g;

/**
 * Last corrections to a formatted title or subtitle: bookseller suffixes, replacement characters
 * where curly quotes were lost, ISBD spacing before punctuation, repeated words, trailing
 * punctuation and unmatched brackets left by truncated catalogue records.
 */
export function polishTitle(text, language) {
  if (!text) return text;
  const french = String(language ?? '').startsWith('French');
  let s = String(text).normalize('NFC')
    // Control characters and MARC non-sorting marks; escape sequences ("\textdegree", "\U+2032\").
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​﻿]/g, '')
    .replace(/\\textdegree\s*/g, '°')
    .replace(/\\U\+([0-9A-F]{4})\\/gi, (_, h) => (h === '2032' ? 'ʹ' : String.fromCodePoint(parseInt(h, 16))))
    .replace(/\{u([0-9A-F]{4})\}/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    // Chinese and Korean book-title marks recorded as angle brackets: "<<Ling yu rou>>", "<Si shu>".
    .replace(/^<P>(?=\p{Ll})/u, 'P')
    .replace(/<<\s*([^<>]+?)\s*>>/g, '“$1”')
    .replace(/<\s*([^<>]+?)\s*>/g, '“$1”')
    // A statement of responsibility left in the title: "Das Kapital / by Karl Marx; edited by …".
    .replace(/\s+\/\s*(by|edited|translated|compiled|von|par|por|di|herausgegeben|hrsg)\b.*$/i, '')
    .replace(/\s*;\s*(ed\.|edited) by .*$/i, '')
    .replace(/\s*--\s*$/, '')
    .replace(/[,:;]\.$/, '')
    .replace(/^"(?=[^"]*»$)/, '«')
    .replace('c�mo', 'cómo').replace('Ме�биуса', 'Мебиуса')
    // Records whose accents or ligature ties were lost: "Comunicacio N?", "Revoli?u?t?s?ionnaii?a?".
    .replace('Europe and de Tente', 'Europe and Détente').replace(/\bLester F Ward\b/, 'Lester F. Ward')
    .replace('Revoli?u?t?s?ionnaii?a? Poe?zii?a?', 'Revoliutsionnaia poeziia')
    .replace(/Comunicacio N\?/, 'Comunicación?').replace(/Concientizacio N\b/, 'Concientización')
    .replace(/\s*\((French|Spanish|German|Italian|Portuguese|English|Russian) Edition\)$/i, '')
    // Lost curly quotes and apostrophes: "�The Historical Experience�", "Khrushchov�s".
    .replace(/(?<=\p{L})�(?=(s|t|ll|re|ve|d)\b)/gu, '’')
    .replace(/(^|[\s(])�+(?=\S)/gu, '$1“')
    .replace(/(?<=\S)�+(?=$|[\s),.:;])/gu, '”')
    .replace(/\s�\s/g, ' — ')
    // ISBD spacing: "ʻAbd Allāh Bādhīb :kitābāt" → "ʻAbd Allāh Bādhīb: kitābāt"; "Die soziale revolution ."
    .replace(/\s+([:;])(?=[^\s\p{M}\p{Lm}])/gu, '$1 ')
    .replace(/(\.\.\.|…)\s+\.$/, '$1')
    .replace(/\s+\.(?=\s|$)/g, '.')
    .replace(/\s+,/g, ',')
    .replace(/\s+([:;?!])(?=\s|$)/g, french ? ' $1' : '$1')
    .replace(/\s*:\p{M}+$/u, '')
    .replace(/\s*\[\s*@[\s.]*$/, '')
    .replace(/(?<!\.)\.\.$/, '.')
    .replace(/[\s,:;/=]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const primary = String(language ?? '').split(', ')[0];
  if (UMLAUT_LANGUAGES.test(primary)) s = s.replace(/(?<=\p{L}|^|\s|-)"([aouAOU])(?=\p{L})/gu, (_, v) => UMLAUT[v]);
  if (HARD_SIGN_LANGUAGES.test(primary)) s = s.replace(/(?<=\p{L})"(?=\p{L})/gu, 'ʺ');
  // An unmatched quotation mark: close an opened quotation, or drop a stray closing one.
  const quotes = s.match(OPEN_QUOTES) ?? [];
  if (quotes.length % 2 === 1 && !/[”»]/.test(s)) {
    if (/["“„«]\s*$/.test(s) && quotes.length === 1) s = s.replace(/\s*["“„«]\s*$/, '');
    else if (/^["“„«]/.test(s) && quotes.length === 1) s = s.slice(1).trim();
    else s += { '„': '“', '«': '»', '“': '”' }[quotes.at(-1)] ?? '"';
  }
  if (String(language ?? '').includes('English')) {
    // "Address to the the First Vice-President", "London District Communist Party Party Delegation".
    s = s.replace(/\b(the|a|an|of|and|to|in|party)\s+\1\b/gi, '$1');
    for (const [from, to] of TITLE_PHRASE_FIXES) s = s.replace(from, to);
    s = s.replace(/\p{L}+(?:['’]\p{L}+)?/gu, (w) => {
      const fixed = TITLE_TYPOS[w.toLowerCase()];
      if (!fixed) return w;
      if (w === w.toUpperCase() && w.length > 1) return fixed.toUpperCase();
      return /^\p{Lu}/u.test(w) ? fixed.charAt(0).toUpperCase() + fixed.slice(1) : fixed;
    });
  }
  // Unmatched brackets from truncated records: "[Tiurkskii iazyk", "(Konets XIXv. … XXv..", "… Trasevich]".
  for (const [open, close] of [['[', ']'], ['(', ')']]) {
    const opens = s.split(open).length - 1;
    const closes = s.split(close).length - 1;
    if (opens > closes) {
      // Drop the last unmatched opening bracket: what follows it stays, without the bracket.
      const at = s.lastIndexOf(open);
      s = (s.slice(0, at) + s.slice(at + 1).replace(/^\s+/, '')).replace(/\s{2,}/g, ' ').trim();
      if (opens - 1 > closes) s += close.repeat(opens - 1 - closes);
    } else if (closes > opens) {
      const at = s.lastIndexOf(close);
      s = (s.slice(0, at) + s.slice(at + 1)).trim();
    }
  }
  s = s.replace(/\s*\[\s*@?\s*\.?$/, '').replace(/[\s,:;/=]+$/, '');
  s = finishTitle(s, primary);
  return s || text;
}

// Abbreviations that keep their full stop at the end of a title: "Bd.", "Nr.", "etc.", "u.a.", "St.".
const FINAL_ABBREVIATION = /(?:^|[\s(])(?:\p{L}|etc|usw|u\.\s?a|u\.\s?s\.\s?w|bzw|Bd|Bde|Nr|No|Vol|St|Jh|Jhs|Co|Inc|Ltd|Dr|Hrsg|Aufl|vol|t|ed|éd|Ed|cf|vs|Abt|Bd|Kap|Tl|T|S|ss|pp|Jr|Sr|Ges|Gesch|Ver|Verl|dt|engl|frz|russ|Anm)\.$/u;
// German nouns written lower-case by older cataloguing ("Die soziale revolution"): words with
// noun-only endings, and common nouns of this catalogue.
const GERMAN_NOUN = /^\p{Ll}\p{L}{2,}(ung|ungen|heit|heiten|keit|keiten|schaft|schaften|tion|tionen|ismus|ität|itäten|nis|nisse|tum|tümer|ment|mente|ierung|ierungen|ik|iker|ikern)$/u;
const GERMAN_NOUNS = new Set('arbeiter arbeiterin arbeiterinnen arbeitern partei parteien krieg kriege kriegs geschichte staat staates welt frau frauen mann männer volk völker volkes land länder leben kampf kämpfe frage fragen kapital programm programme weg wege zeit zeiten jahr jahre jahren buch bücher brief briefe briefen rede reden schrift schriften werk werke werken bauer bauern bewegung genossen genosse sozialdemokratie demokratie diktatur gewerkschaft gewerkschaften jugend kinder kind lehre lehren lage klasse klassen kommunist kommunisten sozialist sozialisten aufsatz aufsätze beitrag beiträge gesetz gesetze recht rechte wahl wahlen sieg frieden friedens freiheit macht markt geld lohn löhne preis preise wert ware waren erde himmel gott kirche christentum bibel stadt dorf haus heimat roman romane gedichte novellen erzählung erzählungen bilder erinnerungen tagebuch tagebücher reise reisen sowjetunion union republik reich deutschland russland frankreich amerika china'.split(' '));
// Nouns found lower-case in German titles here but capitalised in most others.
for (const w of `presse kommune reichstage bericht gestalt arbeiterklasse skizze kapitel polizei klassenkampf
  feind kunst schriftsteller jahrhunderts parteitages november parteivorstandes januar april
  mächte weltkrieges juni jahrestag kongress august industrie dezember programms weltkongress
  plenum exekutivkomitees arbeit aufgaben grundlagen bolschewiki lande sowjets märz theater
  wiederkehr todestages ende massen krise armee interessen vorwort sache fünfjahrplans reiches
  zeichen grundgesetz artikel berichte zukunft übersicht arbeiters lebensgeschichte kraft sprache
  sammelband theorien theorie praxis teilnehmer philosophie studie profit bänden demokrat abkommen
  westberlin parteitag karl materialien vortragszyklus kader problemen politbüros soziologie erich
  berlin übergangs italien bodenreform kultur strategie zentralkomitees generaldirektoren
  kombinate parteiorganisatoren leipzig generalsekretär staatsrates honecker friedenskampf aspekte
  lenins ökonomie band etappe weltkrieg tage initiative aufbau methoden glück bestandteile
  probleme anhang marsch versuch wandel skizzen hamburg oktober formen tatsachen arbeiterpartei
  juli legislaturperiode untergang niederlage religion blick grundlage zustände brüsseler mutter
  holzindustrie prozess system bauernkrieg jahrhundert österreich flotte gegenwart
  sozialgeschichte alternativen prosa bürgerkrieg proletariats front mord pitaval verbrechen
  vertrag strafrecht tschechoslowakei familie peter bourgeoisie session studien proletariat
  februar grundfragen märchen legende grenzen konferenz exekutive weltkongresses betriebes
  textausgabe warschauer schutz europa antwort sowjetmacht propaganda periode analyse fünfjahrplan
  bonner interviews marx handbuch deutschlands protokoll köln gewerkschaftsarbeit material stunden
  lehrer lebensbild jahrzehnte plan dienst reform standpunkt struktur zahlen wohnungsfrage monate
  wald`.split(/\s+/)) GERMAN_NOUNS.add(w);

/** Last touches: leftover punctuation, cataloguers' notes, lost characters and German noun case. */
function finishTitle(text, primary) {
  let s = text
    // A subtitle that began with the ";" between works: ": ; Dialektik der Natur".
    .replace(/^[;:,]\s*/, '')
    // Characters the record could not store: "\"??\", Choix d'articles".
    .replace(/"\?{2,}"\s*,?\s*/g, '').replace(/(^|\s)\?{2,}(?=\s|$)/g, '$1')
    // A statement of responsibility in brackets: "[Von Adolf Braun et al.]", "[par …]".
    .replace(/\s*\[(?:von|by|par|por|di|hrsg|herausgegeben|ed|edited|übers|translated|trad)\b[^\]]*\]/gi, '')
    // A name left after the title: "Character and Growth of a New Art / Bela Balazs;".
    .replace(/\s\/\s[^/;]+;\s*$/, '')
    // A leading article quoted as a non-filing mark: "“Die” Preussischen Wahlgesetze".
    .replace(/^[“"](Die|Der|Das|Den|Le|La|Les|Il|Lo|El|Los|Las|The)[”"]\s+/, '$1 ')
    .replace(/([!?])\.$/, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // The cataloguer's final full stop, kept after an abbreviation or an ellipsis.
  if (/[^.]\.$/.test(s) && !FINAL_ABBREVIATION.test(s) && !/\b[A-ZÀ-Ž]\.[A-ZÀ-Ž]\.$/u.test(s)) s = s.slice(0, -1);
  // Vietnamese D with stroke recorded as the Icelandic eth: "Phạm-Văn-Ðồng".
  if (/Vietnamese/.test(primary ?? '') || /[ạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹơư]/i.test(s)) s = s.replace(/Ð/g, 'Đ').replace(/ð/g, 'đ');
  // Romance-language titles keyed in Title Case: "Historia de La Sexualidad", "Las Modas Y la Explotación".
  const ROMANCE_FUNCTION = /(?<![.!?:;\-–] ?|^)\b(Et|De|Du|Des|Le|La|Les|En|Au|Aux|Y|Del|Los|Las|Di|E|Da|Do|Dos|Das|Della|Dei|Per|Con|Il|Al|Sur|Pour|Par|Dans|Sobre|Para|Por|Com|Em|Na|Nella|Sul|Una|Un|Une|Ou|O)(?= )/g;
  if (/^(French|Spanish|Italian|Portuguese|Catalan|Galician)/.test(primary ?? '') && (s.match(ROMANCE_FUNCTION) ?? []).length >= 2) {
    s = s.replace(ROMANCE_FUNCTION, (w) => w.toLowerCase());
  }
  if (/^German/.test(primary ?? '')) {
    s = s.replace(/(?<=[\s\-(„"“'])\p{Ll}[\p{L}]+/gu, (w) =>
      (w.length > 5 && GERMAN_NOUN.test(w)) || GERMAN_NOUNS.has(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Author names
// ---------------------------------------------------------------------------

// Library of Congress romanisation ties (T͡s, i͡u), dropped for display: "T︠S︡K" → "TSK".
const TIES = /[︠͡-︣]/g;

// Family names that come first in Chinese, Korean and Vietnamese (Pinyin, Wade-Giles, McCune-Reischauer).
const EAST_ASIAN_SURNAMES = new Set(
  (
    'zhao qian sun li zhou wu zheng wang feng chen chu wei jiang shen han yang zhu qin xu he lu shi zhang kong cao ' +
    'yan hua jin tao xie zou yu bai shui dou yun su pan ge fan peng lang wei chang ma miao feng fang ren yuan liu ' +
    'bao tang fei lian cen xue lei ni teng yin luo bi hao an qi kang wu yu yuan bu gu meng ping huang mu xiao yao ' +
    'shao zhan wang qi mao di mi bei ming zang ji fu cheng dai tan song pang xiong ji shu qu xiang zhu dong liang ' +
    'du ruan lan min xi ji jia lu jiang guo mei sheng lin diao zhong qiu luo gao xia cai tian hu ling ho wan zhi ' +
    'ke zan guan lu mo jing fang qiu miao gan xie ying zong ding xuan deng yu shan hang hong bao zhu zuo shi cui ' +
    'ji niu gong cheng ji xing hua pei lu rong weng xun yang yu hui zhen qu jia feng rui yi chu jin ji bing mi song ' +
    'jing duan fu wu wu jiao ba gong mu kui shan gu che hou mi peng quan xi ban yang qiu zhong yi gong ning qiu luan ' +
    'bao gan tou li rong zu wu fu liu jing zhan shu long ye xing si shao gao li ji bo yin su bai huai pu tai cong e ' +
    'suo xian ji lai zhuo lin tu meng chi qiao yin yu xu nai cang shuang wen shen dang zhai tan gong lao pang ji shen ' +
    'fu du ran zai li yong que qu sang gui pu niu shou tong bian hu yan ji jia pu shang nong wen bie zhuang yan chai ' +
    'qu yan chong mu lian ru xi huan ai yu rong xiang gu yi shen ge liao yu zhong ji ju heng bu du geng man hong ' +
    'kuang guo wen kou guang lu que dong ou shu wo li wei yue kuai kui long ' +
    // Wade-Giles spellings
    'chao chou chiang chang chen cheng chi chien chin ching chu chuang hsu hsia hsiao hsieh hsing hsiung hsueh ' +
    'jen jao kao ko kuo kung lo teng tsai tsao tseng tso tsou tung wu yeh yen ' +
    // Korean and Vietnamese
    'kim pak park choe choi chong jong ri rim o han kang cho yun sin shin ' +
    'nguyen tran le pham hoang huynh phan vu vo dang bui do ho ngo duong ly truong dinh lam mai trinh phung ' +
    // Compound surnames
    'sima ouyang zhuge situ shangguan murong szuma'
  ).split(' '),
);

// Organisations rather than people; "Communist International. Executive Committee" has dotted segments.
const CORPORATE_WORDS = /\b(party|partii|partei|committee|komitet|congress|conference|konferenz|institut\w*|ministry|union|government|council|bureau|academy|akademie|league|federation|association|society|department|agency|press|publishing|school|university|kpss|ssr|sed|zk)\b/i;
// "Communist International. Executive Committee" — a whole word, a full stop, then another heading;
// not an initial followed by a surname ("V. Iraianbu").
const CORPORATE_SEGMENTS = /\p{L}{3,}\.\s+\p{Lu}\p{Ll}{2,}/u;
const isCorporate = (s) => CORPORATE_WORDS.test(s) || CORPORATE_SEGMENTS.test(s);

const plainLetters = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/đ/g, 'd');

/**
 * Vietnamese letters: đ, ơ, ư, or a vowel carrying both a quality mark (circumflex, breve, horn)
 * and a tone mark ("ồ"); French "ô" alone does not count. Tested on decomposed text.
 */
/**
 * Repairs Vietnamese letters whose marks were recorded tone first ("Hò̂" for "Hồ") or after a
 * stray space ("Hô ̀"), which do not compose and display as loose accents.
 */
export function fixVietnameseMarks(s) {
  return String(s)
    .normalize('NFD')
    .replace(/\s+(?=[̀-ͯ])/g, '')
    .replace(/([̀́̃̉])([̛̂̆])/g, '$2$1')
    .normalize('NFC');
}

/**
 * Tidies an author heading from a catalogue record: removes romanisation ties, life dates and
 * stray full stops, repairs split corporate headings, and puts personal names in natural order —
 * "Given Family" for Western names, "Family Given" (without the comma) for East Asian names
 * when the record comes from an East Asian house.
 */
export function formatAuthor(raw, eastAsian = false) {
  let s = fixVietnameseMarks(raw).replace(TIES, '').replace(/\s+/g, ' ').trim();

  // "France) International Socialist Congress (5th 1900 Paris" → "International Socialist Congress (5th 1900 Paris, France)"
  const split = s.match(/^([^()]+)\)\s+(.+\([^)]*)$/);
  if (split) s = `${split[2]}, ${split[1]})`;

  // Role words after the name: "Lenin, Vladimir Ilʹich, 1870-1924, author".
  s = s.replace(/,\s*(author|editor|translator|compiler|contributor|illustrator|ed\.|tr\.|comp\.)\.?$/i, '').trim();
  // Life dates: "Reed, John, 1887-1920." / "Lenin, V. I. (1870-1924)" / "China (People's Republic of China : 1949- )"
  s = s.replace(/,?\s*[:(]?\s*\b(1[5-9]|20)\d\d\??\s*-\s*((1[5-9]|20)\d\d\??)?\s*\)?\.?$/, '').trim();
  // Trailing punctuation, keeping the full stop of a final initial ("V. I.").
  s = s.replace(/[\s,;:]+$/, '');
  if (/\.$/.test(s) && !/(^|[\s.])\p{Lu}\.$/u.test(s)) s = s.slice(0, -1);
  if ((s.match(/\(/g) ?? []).length > (s.match(/\)/g) ?? []).length) s += ')';

  if (isCorporate(s) || /\d/.test(s)) return s;

  // Honorifics ("Dr T Geenakumari"), service titles and degrees after the name ("V. Iraianbu I. A. S"),
  // and undotted initials ("K R Ramachandran" → "K. R. Ramachandran").
  s = s.replace(/^(dr|prof|professor|shri|sri|smt|mr|mrs|ms|comrade)\.?\s+/i, '');
  s = s.replace(/[\s,]+(i\.?\s*a\.?\s*s|i\.?\s*p\.?\s*s|i\.?\s*f\.?\s*s|ph\.?\s*d|m\.?\s*a|m\.?\s*phil|d\.?\s*litt)\.?$/i, '');
  s = s.replace(/(^|\s)(\p{Lu})(?=\s|$)/gu, '$1$2.');

  // ALL-CAPS personal names: "HEWLETT JOHNSON", "E. A. KRASNOSHCHEKOV", "BRITTAIN" (short acronyms are left alone).
  const tokens = s.split(' ');
  const acronymLike = (t) => { const w = t.replace(/[^\p{L}]/gu, ''); return w.length <= 3 || !/[AEIOUY]/i.test(w); };
  if (s === s.toUpperCase() && s !== s.toLowerCase() && !tokens.every(acronymLike)) {
    s = tokens.map((t) => t.charAt(0) + t.slice(1).toLowerCase()).join(' ');
  }

  const inverted = s.match(/^([^,]+),\s*([^,]+)$/);
  if (inverted) {
    const [, family, given] = inverted;
    // Vietnamese names keep family-name-first order whichever house printed them ("Hồ, Chí Minh").
    const vietnamese = VIETNAMESE_LETTERS.test(s) && VIETNAMESE_SURNAMES.has(plainLetters(family));
    const familyFirst = (eastAsian || vietnamese) && isEastAsianSurname(family);
    return familyFirst ? `${family} ${given}` : `${given} ${family}`;
  }
  return eastAsian ? familyNameFirst(s) : s;
}

const isEastAsianSurname = (w) => EAST_ASIAN_SURNAMES.has(plainLetters(w).replace(/[^a-z]/g, ''));

// Surnames common enough to be read as the family name even when the given name is also a surname.
const COMMON_SURNAMES = new Set('nguyen tran le pham hoang phan vu vo dang bui do ho ngo duong kim pak ri choe zhang wang li liu chen yang zhao huang zhou wu'.split(' '));

// One to three romanised Chinese, Korean or Vietnamese syllables: "zhao", "libo", "guangyao", "giap", "sŏng".
const SYL = "[bcdfghjklmnpqrstvwxz']{0,4}[aeiouy]{1,3}(?:ng|nh|ch|[nmrptkl])?";
const SYLLABIC_WORD = new RegExp(`^(?:${SYL}){1,3}$`);
const isSyllabic = (name) => name.split(/[\s-]+/).every((part) => SYLLABIC_WORD.test(plainLetters(part).replace(/[^a-z']/g, '')));

const VIETNAMESE_SURNAMES = new Set('nguyen tran le pham hoang huynh phan vu vo dang bui do ho ngo duong ly truong dinh lam mai trinh phung'.split(' '));
const VIETNAMESE_LETTERS = /[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹõãĩũ]/i;

/**
 * East Asian names that catalogue records give in Western order ("Nguyên Giáp Võ", "Shu-li Chao")
 * are put family name first ("Võ Nguyên Giáp", "Chao Shu-li"). Only names made entirely of
 * romanised syllables are touched, so Western names such as "Edgar Snow" are left alone.
 */
function familyNameFirst(s) {
  const words = s.split(' ');
  if (words.length < 2 || words.length > 4 || !isSyllabic(s)) return s;
  const [first] = words;
  const last = words.at(-1);
  const lastKey = plainLetters(last).replace(/[^a-z]/g, '');
  if (!isEastAsianSurname(last)) return s;
  // A Vietnamese name ending in a family name has been flipped, even when a middle name is also a surname.
  if (VIETNAMESE_LETTERS.test(s) && VIETNAMESE_SURNAMES.has(lastKey)) return [last, ...words.slice(0, -1)].join(' ');
  if (isEastAsianSurname(first) && !(COMMON_SURNAMES.has(lastKey) && !COMMON_SURNAMES.has(plainLetters(first).replace(/[^a-z]/g, '')))) return s;
  return [last, ...words.slice(0, -1)].join(' ');
}

// ---------------------------------------------------------------------------
// Scripts: romanisation of Indic and Cyrillic names, fuller forms of names
// ---------------------------------------------------------------------------

// Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada and Malayalam share one
// layout, 128 code points apart, so one table (indexed by offset within the block) covers them all.
// Simplified romanisation without diacritics, as used for names in English ("Radhakrishnan").
const INDIC_BLOCKS = [0x0900, 0x0980, 0x0a00, 0x0a80, 0x0b00, 0x0b80, 0x0c00, 0x0c80, 0x0d00];
const INDIC_VOWELS = { 0x05: 'a', 0x06: 'a', 0x07: 'i', 0x08: 'i', 0x09: 'u', 0x0a: 'u', 0x0b: 'ri', 0x0c: 'li', 0x0d: 'e', 0x0e: 'e', 0x0f: 'e', 0x10: 'ai', 0x11: 'o', 0x12: 'o', 0x13: 'o', 0x14: 'au' };
const INDIC_CONSONANTS = {
  0x15: 'k', 0x16: 'kh', 0x17: 'g', 0x18: 'gh', 0x19: 'ng', 0x1a: 'ch', 0x1b: 'chh', 0x1c: 'j', 0x1d: 'jh', 0x1e: 'ny',
  0x1f: 't', 0x20: 'th', 0x21: 'd', 0x22: 'dh', 0x23: 'n', 0x24: 't', 0x25: 'th', 0x26: 'd', 0x27: 'dh', 0x28: 'n',
  0x29: 'n', 0x2a: 'p', 0x2b: 'ph', 0x2c: 'b', 0x2d: 'bh', 0x2e: 'm', 0x2f: 'y', 0x30: 'r', 0x31: 'r', 0x32: 'l',
  0x33: 'l', 0x34: 'zh', 0x35: 'v', 0x36: 'sh', 0x37: 'sh', 0x38: 's', 0x39: 'h', 0x58: 'q', 0x59: 'kh', 0x5a: 'gh',
  0x5b: 'z', 0x5c: 'r', 0x5d: 'rh', 0x5e: 'f', 0x5f: 'y',
};
const INDIC_SIGNS = { 0x3e: 'a', 0x3f: 'i', 0x40: 'i', 0x41: 'u', 0x42: 'u', 0x43: 'ri', 0x44: 'ri', 0x46: 'e', 0x47: 'e', 0x48: 'ai', 0x4a: 'o', 0x4b: 'o', 0x4c: 'au' };
const INDIC_MARKS = { 0x01: 'n', 0x02: 'm', 0x03: 'h' };
const INDIC_VIRAMA = 0x4d;
// Malayalam chillu letters (final consonants) and Bengali khanda ta.
const INDIC_EXTRA = { 0x0d7a: 'n', 0x0d7b: 'n', 0x0d7c: 'r', 0x0d7d: 'l', 0x0d7e: 'l', 0x0d7f: 'k', 0x09ce: 't' };

const CYRILLIC = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'iu', я: 'ia', і: 'i', ї: 'i', є: 'ie', ґ: 'g', ў: 'u',
};

const NON_LATIN = /[Ѐ-ӿऀ-෿]/;
const isInitialOnly = (w) => /^\p{L}\.?$/u.test(w);

function indicOffset(cp) {
  const block = INDIC_BLOCKS.find((b) => cp >= b && cp < b + 0x80);
  return block === undefined ? -1 : cp - block;
}

// Initials written in Indic scripts spell out the English letter name ("ಟಿ.ಆರ್." = "T. R.").
const LETTER_NAMES = {
  e: 'A', bi: 'B', si: 'C', di: 'D', i: 'E', ef: 'F', eph: 'F', ji: 'G', ech: 'H', ai: 'I', je: 'J', ke: 'K',
  el: 'L', em: 'M', en: 'N', o: 'O', pi: 'P', kyu: 'Q', ar: 'R', es: 'S', ti: 'T', yu: 'U', vi: 'V', eks: 'X',
  vai: 'Y', jed: 'Z', zed: 'Z',
};

/** Romanises one Indic or Cyrillic word; other characters pass through. */
function romaniseWord(word) {
  // Initials joined by full stops ("ಟಿ.ಆರ್.") are romanised part by part.
  if (/\.\S/.test(word)) return word.split(/(?<=\.)/).map((part) => romaniseWord(part)).join(' ');
  if (word.endsWith('.') && word.length > 1) {
    const letters = romaniseWord(word.slice(0, -1)).replace(/\.$/, '');
    const letter = LETTER_NAMES[letters.toLowerCase()];
    if (letter || letters.length <= 3) return `${letter ?? letters.charAt(0).toUpperCase()}.`;
    return `${letters}.`;
  }
  const chars = [...word];
  // North Indian scripts drop the final inherent "a" (Hindi, Marathi, Bengali); South Indian ones keep it.
  const northern = chars.some((c) => { const cp = c.codePointAt(0); return cp >= 0x0900 && cp < 0x0b00; });
  let out = '';
  let consonants = 0;
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i].codePointAt(0);
    const lower = chars[i].toLowerCase();
    if (lower in CYRILLIC) { out += CYRILLIC[lower]; continue; }
    if (cp in INDIC_EXTRA) { out += INDIC_EXTRA[cp]; continue; }
    const off = indicOffset(cp);
    if (off < 0) { out += chars[i]; continue; }
    if (off in INDIC_VOWELS) out += INDIC_VOWELS[off];
    else if (off === 0x02) {
      // Anusvara takes the nasal of the following consonant: "m" before p/b/m, otherwise "n".
      const next = chars[i + 1] ? INDIC_CONSONANTS[indicOffset(chars[i + 1].codePointAt(0))] : undefined;
      out += next === undefined || /^[pbm]/.test(next) ? 'm' : 'n';
    }
    else if (off in INDIC_MARKS) out += INDIC_MARKS[off];
    else if (off in INDIC_CONSONANTS) {
      consonants++;
      out += INDIC_CONSONANTS[off];
      const next = chars[i + 1] ? indicOffset(chars[i + 1].codePointAt(0)) : -1;
      if (next in INDIC_SIGNS) { out += INDIC_SIGNS[next]; i++; }
      else if (next === INDIC_VIRAMA) i++;
      else if (!(northern && i === chars.length - 1)) out += 'a';
    }
  }
  // A lone consonant is an initial, e.g. Malayalam "ച" → "C."
  if (consonants === 1 && [...word].length <= 2 && /^[a-z]+a$/.test(out)) return `${out[0].toUpperCase()}.`;
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** "രാധാകൃഷ്ണന് ച" → "Radhakrishnan C.", "Лев Толстой" → "Lev Tolstoi". */
export const romanise = (name) => name.split(/(\s+)/).map((w) => (/\S/.test(w) ? romaniseWord(w) : w)).join('');

/**
 * A fuller recorded form of a name that is typed only partially ("E. M. S. Namboodiripad"): a
 * spelling with the same words in the same order, each initial written out in place and every
 * full word unchanged — so "M Gokuldas" is never turned into a different "Gokuldas Menon".
 */
function fullerForm(name, alternates) {
  const words = name.replace(/\.(?=\S)/g, '. ').split(/\s+/).filter(Boolean);
  if (!words.some(isInitialOnly)) return name;
  const key = (w) => plainLetters(w).replace(/[^a-z]/g, '');
  let best = name;
  for (const alt of alternates) {
    if (NON_LATIN.test(alt) || /\d/.test(alt)) continue;
    const candidate = formatAuthor(alt);
    const cw = candidate.split(/\s+/);
    if (cw.length !== words.length || cw.filter(isInitialOnly).length >= words.filter(isInitialOnly).length) continue;
    const fits = words.every((w, i) =>
      isInitialOnly(w) ? key(cw[i]).startsWith(key(w)) : key(cw[i]) === key(w),
    );
    if (fits && candidate.length > best.length) best = candidate;
  }
  return best;
}

/**
 * The display form of an author: fuller where the record allows it, and, for names in Indic or
 * Cyrillic script, the romanised form with the original in brackets — "Radhakrishnan C.
 * (രാധാകൃഷ്ണന് ച)". Romanised names from regional-language houses gain their native form too.
 */
// Placeholders catalogues put where no author is known.
const PLACEHOLDER = /^(not\s+mentioned|unknown|anonymous|anon\.?|various|n\.?\s*a\.?|none|no\s+author|author|editor|n\.?\s*d\.?)$/i;

// Writers who style their own names in lower case.
const LOWER_CASE_BY_CHOICE = new Set(['bell hooks', 'adrienne maree brown']);
// Words kept lower-case inside a name: "Victor del Litto", "Industrial Workers of the World".
const NAME_PARTICLES = new Set('and & of the de del della da di du van von der den la le y e'.split(' '));

/**
 * Casing fixes for an author's name: an all-lower-case personal name is capitalised ("louis
 * althusser" → "Louis Althusser"), an ALL-CAPS organisation is title-cased, and the Japanese
 * editor's mark "hen" ("edited by") is dropped from the end of a name.
 */
export function tidyName(name) {
  if (!name) return name;
  let n = name.replace(/\s+(hen|henshū|hencho|kanshū)$/u, '');
  // Archive records that append the real name: "Lenin, Vladimir (Vladimir Ilʹič), is Vladimir Ilʹič
  // Ulʹjanov" → "Lenin, Vladimir".
  if (/,\s+is\s+\S/.test(n)) n = n.replace(/,\s+is\s+.*$/, '').replace(/\s*\([\p{Script=Latin}\s.ʹ'’-]+\)$/u, '');
  if (LOWER_CASE_BY_CHOICE.has(n)) return n;
  const letters = n.replace(/[^\p{L}]/gu, '');
  const words = n.split(/\s+/);
  const capitalise = (s) =>
    s
      .split(/(\s+)/)
      .map((w, i) =>
        i > 0 && NAME_PARTICLES.has(w.toLowerCase())
          ? w.toLowerCase()
          : w
              .toLowerCase()
              .replace(/(^|[.\-/'’])(\p{Ll})/gu, (_, p, c) => p + c.toUpperCase())
              .replace(/^([DL])(['’])/, (_, c, q) => (i > 0 ? c.toLowerCase() : c) + q)) // "de Bremond d'Ars"
      .join('');
  // ALL CAPS with three or more words: "MARXISTISCH-LENINISTISCHE PARTEI DEUTSCHLANDS".
  if (words.length >= 3 && letters.length > 10 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) return capitalise(n);
  // Entirely lower case, two or more words of Latin letters: a personal or organisation name.
  if (words.length >= 2 && /^[\p{Script=Latin}\s.,&/'’-]+$/u.test(n) && letters === letters.toLowerCase() && letters.length > 5 &&
      !/^(see |edited|eds?\b|collective)/.test(n)) {
    return capitalise(n);
  }
  return n;
}

export function displayAuthor(name, alternates = [], { eastAsian = false, showNative = false } = {}) {
  if (PLACEHOLDER.test(String(name).trim())) return null;
  const n = displayAuthorName(repairEncoding(name), alternates, { eastAsian, showNative });
  return polishCredit(NON_LATIN.test(n) ? n : tidyName(n));
}

// Credits that are not names: catalogue placeholders left after formatting.
const NOT_A_NAME = /^(n\/a|a|v|collective|edited|eds?\.?|see above.*|aa\.?\s*vv\.?|publishers?\s.*)$/i;
// MARC-8 text decoded as something else: stray symbols, or accents stacked on accents or punctuation.
const isGarbled = (s) =>
  /[♭®£�]/.test(s) || (/^[\p{Script=Latin}\p{M}\p{P}\p{S}\p{Zs}\p{Lm}]+$/u.test(s) && /[\p{M}\p{Lm}\p{P}\p{S}]\p{M}/u.test(s.normalize('NFC')));
/**
 * Credits with several names: "Achille Loria; John Leslie Garner", "Chesnais / Plihon" become one
 * credit each, formatted as headings ("Lenin, Vladimir Ilʹich, 1870-1924" → "Vladimir Ilʹich Lenin").
 * A fragment that is only part of another name ("Melanie Wills Peter; Peter") is dropped.
 */
export function splitCredits(credits) {
  const out = [];
  for (const c of credits ?? []) {
    const parts = String(c).split(/\s*;\s*|\s+\/\s+/).map((p) => p.trim()).filter((p) => /\p{L}/u.test(p));
    if (parts.length < 2) { out.push(c); continue; }
    const names = parts.map((p) => (/,/.test(p) ? formatAuthor(p.replace(/\s+comp\.?$/i, '')) : p));
    out.push(...names.filter((n, i) => !names.some((m, j) => j !== i && m.length > n.length && m.includes(n))));
  }
  return out;
}

// The second part of a place heading, which is not a given name: "Moscow, Russia. Akademiia …".
const PLACE_QUALIFIER = /^(Russia|China|Bessarabia|Czechoslovakia|Ger\.?|Germany|Poland|Ukraine|Latvia|Lithuania|Estonia|Bulgaria|Romania|Hungary|Yugoslavia|Korea|Japan|Vietnam|India|France|Italy|Spain|Cuba|Mexico|England|Scotland|Wales|Ireland|Austria|Switzerland|Belgium|Netherlands|Sweden|Norway|Denmark|Finland|Greece|Turkey|Iran|Iraq|Egypt|Israel|Calif|Mass|N\.Y|Ill)\b/;

// Names that may start in lower case: particles and writers who style their names so.
const LOWER_START = /^(bell hooks|adrienne maree brown|communia|fracoco|de |del |della |di |da |van |von |d['’]|al-|el-|ha-|ibn )/;

// Headings that the rules cannot repair: inverted organisation names and titles of nobility.
const CREDIT_FIXES = {
  'comte de Saint-Simon Claude Henri de Rouvroy': 'Henri de Saint-Simon',
  'comte Louis-Antoine de Bougainville': 'Louis-Antoine de Bougainville',
  'comte de Louis-Antoine Bougainville': 'Louis-Antoine de Bougainville',
  'comte de Lapérouse Jean-François de Galaup': 'Jean-François de La Pérouse',
  "baron d'Aubonne Jean Baptiste Tavernier": 'Jean-Baptiste Tavernier',
  'N. S. knyaz Trubetskoi': 'N. S. Trubetskoi',
  'Petr Andreevich kni Łaz £ Vi Łazemskii': 'Petr Andreevich Viazemskii',
  'monk Savva': 'Savva (monk)',
  'khāṣṣ hājib Yūsuf': 'Yūsuf Khāṣṣ Ḥājib',
  'lirik i satirik Duško M. Petrović': 'Duško M. Petrović',
  'charles denby (matthew ward)': 'Charles Denby (Matthew Ward)',
  'george n. Shuster': 'George N. Shuster',
  'i.compton-burnett': 'I. Compton-Burnett',
  'compton-burnett': 'I. Compton-Burnett',
  "igor' Malishevskii": "Igor' Malishevskii",
  'hViktor Yegorychev': 'Viktor Yegorychev',
  'órbergur Thor arson': 'Þórbergur Þórðarson',
  'želtov, Aleksej, S.': 'Aleksej S. Želtov',
  'iU Grachevskiĭ': 'IU. Grachevskiĭ',
  'herodote-revue': 'Hérodote',
  'o ピアトニッキー': 'ピアトニッキー',
  'Leff, Samuel.': 'Samuel Leff',
  'Karel (Social scientist) Hlavaty': 'Karel Hlavaty',
  'Hint, Aadu. Vatku tōbilas': 'Aadu Hint',
  'Dinev, Taniu. Regulirane na migratsiiata': 'Taniu Dinev',
  'Rothstein, Mrs. Carolyn Green': 'Carolyn Green Rothstein',
  'U. S A. Staff Revolutionary Communist Party': 'Revolutionary Communist Party, USA',
  'Lenin, Vladimir Ilâich, 1870-1924': 'Vladimir Ilʹich Lenin',
  'dit aussi David Osipovitch Zaslavskiĭ David Iosifovitch': 'David Zaslavskiĭ',
  'the Editorial Board of Jiefangjun Bao [ Liberation Army Daily ] as a guide for t': 'The Editorial Board of Jiefangjun Bao (Liberation Army Daily)',
  'dang Zhongguo gong chan': 'Zhongguo gong chan dang',
  'tang Chung-Kuo Kung Chán': "Chung-kuo kung ch'an tang",
  'tang Chung-kuo kung chʻan': "Chung-kuo kung chʻan tang",
  'social and cultural rights International covenant on economic': 'International Covenant on Economic, Social and Cultural Rights',
  'etc Leningrad (R.S.F.S.R.). Ordinances': 'Leningrad (R.S.F.S.R.). Ordinances, etc.',
  'der (MLPD), Zentralkomitee Marxistisch-Leninistischen Partei Deutschland': 'Marxistisch-Leninistische Partei Deutschlands. Zentralkomitee',
  'iskusstva i iazyka Komakademii (Soviet Union) Institut literatury': 'Kommunisticheskaia akademiia (Soviet Union). Institut literatury, iskusstva i iazyka',
  'iskusstva i iazyka Kommunisticheskaia akademiia (Soviet Union). Sektsiia literatury': 'Kommunisticheskaia akademiia (Soviet Union). Sektsiia literatury, iskusstva i iazyka',
  'der Literatur- und Kunstwissenschaften Multilaterale Kommission Sozialistischer Länder für Probleme der Kulturtheorie': 'Multilaterale Kommission Sozialistischer Länder für Probleme der Kulturtheorie, der Literatur- und Kunstwissenschaften',
  'la Ciencia y el Deporte (Cuba). Congreso Sindicato Nacional de Trabajadores de la Educación': 'Sindicato Nacional de Trabajadores de la Educación, la Ciencia y el Deporte (Cuba). Congreso',
  'gia đình và môi trường trong phát triển (Vietnam) Trung tâm nghiên cứu giới': 'Trung tâm nghiên cứu giới, gia đình và môi trường trong phát triển (Vietnam)',
  'thể thao và du lịch Bắc Giang (Vietnam). Sở văn hóa': 'Sở văn hóa, thể thao và du lịch Bắc Giang (Vietnam)',
  'stroitelʹstva i transporta Respublikanskaia nauchno-prakticheskaia konferentsiia Osnovnye napravleniia povysheniia ėffektivnosti promyshlennosti': 'Respublikanskaia nauchno-prakticheskaia konferentsiia "Osnovnye napravleniia povysheniia ėffektivnosti promyshlennosti, stroitelʹstva i transporta"',
  'posviashchennaia piatidesiatiletiiu gorodskoi partiinoi organizatsii (1967 Kishinev) Nauchno-teoreticheskaia konferentsiia': 'Nauchno-teoreticheskaia konferentsiia, posviashchennaia piatidesiatiletiiu gorodskoi partiinoi organizatsii (1967 Kishinev)',
  'posviashchennaia 100-letiiu so dnia rozhdeniia Vladimira Ilʹicha Lenina Kishinev? 1970? Respublikanskaia nauchno-teoreticheskaia konferentsiia propagandistov': 'Respublikanskaia nauchno-teoreticheskaia konferentsiia propagandistov, posviashchennaia 100-letiiu so dnia rozhdeniia Vladimira Ilʹicha Lenina (1970 Kishinev)',
  'mikrobiologii i gigieny Kazakhskiĭ institut e̊pidemiologii': 'Kazakhskiĭ institut ėpidemiologii, mikrobiologii i gigieny',
  'literatury i istorii Akademiia nauk SSSR. Kirgizskii filial. Institut iazyka': 'Akademiia nauk SSSR. Kirgizskii filial. Institut iazyka, literatury i istorii',
  'sociologijos ir teisės institutas (Lietuvos Mokslų akademija) Filosofijos': 'Lietuvos Mokslų akademija. Filosofijos, sociologijos ir teisės institutas',
  'posviashchennaia 50-letiiu prisvoeniia Komsomolu imeni V.I.Lenina Moscow 1973? Vsesoiuznaia nauchnaia konferentsiia "Lenin i molodezh"': 'Vsesoiuznaia nauchnaia konferentsiia "Lenin i molodezh", posviashchennaia 50-letiiu prisvoeniia Komsomolu imeni V. I. Lenina (1973 Moscow)',
  'vysshikh organov gosudarstvennoĭ vlasti i organov gosudarstvennogo upravleniia SSSR TSentralʹnyĭ gosudarstvennyĭ arkhiv Oktiabrʹskoĭ revoliutsii': 'TSentralʹnyĭ gosudarstvennyĭ arkhiv Oktiabrʹskoĭ revoliutsii, vysshikh organov gosudarstvennoĭ vlasti i organov gosudarstvennogo upravleniia SSSR',
  'arkheologiia va ėtnografiia (Akademiiai fanḣoi RSS Tojikiston) Instituti taʺrikh': 'Akademiiai fanḣoi RSS Tojikiston. Instituti taʺrikh, arkheologiia va ėtnografiia',
  'iazyka i literatury (Akademiia nauk SSSR. Turkmenskiĭ filial) Institut istorii': 'Akademiia nauk SSSR. Turkmenskiĭ filial. Institut istorii, iazyka i literatury',
  'lesního a vodního hospodářství Czechoslovakia. Ministerstvo zemědělství': 'Czechoslovakia. Ministerstvo zemědělství, lesního a vodního hospodářství',
  'lesního a vodního hospodarství Výnos ministra.. o mzdovych podminkach delniků Czechoslovakia. Ministerstvo zemědelství': 'Czechoslovakia. Ministerstvo zemědělství, lesního a vodního hospodářství',
};

/**
 * Last corrections to a displayed credit: placeholders and garbled MARC-8 text are dropped, a
 * leading "ed." or "by" removed, lower-case initials and romanised Chinese given names put right
 * ("zhiyi Zhang" → "Zhang Zhiyi"), and any other credit starting in lower case capitalised.
 */
export function polishCredit(name) {
  if (name == null) return name;
  let s = String(name).normalize('NFC')
    .replace(/[\u0000-\u001F\u007F-\u009F​﻿]/g, '')
    .replace(/\{u([0-9A-F]{4})\}/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    // A Latin letter written as its code inside a word: "Hye-gy014Fng" → "Hye-gyŏng".
    .replace(/(?<=\p{Ll})(0[12][0-9A-F]{2})(?=\p{Ll})/gu, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\s+/g, ' ').trim().replace(/[\s,;:]+$/, '');
  if (s in CREDIT_FIXES) return CREDIT_FIXES[s];
  if (!s || NOT_A_NAME.test(s) || /^\.?\s*aa\.?\s*vv\.?$/i.test(s) || isGarbled(s)) return null;
  s = s
    // "et al." and its catalogue forms: "Howard ... [et al.] Bird", "A. A. [red.et al Gubera", "Sherriff and Others".
    .replace(/\s*(\.\.\.|…|(\.\s){2,}\.?)?\s*\[?\s*(red\.?\s*)?et\.?\s*al\.?\s*\]?\s*/gi, ' ')
    .replace(/\s+and others$/i, '')
    // Codes, compiler labels, academic titles and post-nominal letters.
    .replace(/^[\d\-/$]+\s+(?=\p{L})/u, '')
    .replace(/^(sostavitel['ʹ’]?|sost\.|red\.|redaktor|hrsg\.|compiled by|translated by)[:\s]+/i, '')
    .replace(/^(prof\.?|professor|dr\.?|d\.\s?sc\.?)\s+/i, '')
    .replace(/((\s|,\s)(FBA|FRSL|FRHistS|FRS|FRSE|OBE|MBE|CBE|KBE|PhD|Ph\.D\.|M\.A\.|MP|Doc\.|Ing\.?))+$/g, '')
    // Life dates and roles after a heading: "Benni, Stefano (1947-....)", "Baricco, Alessandro. Auteur", "藤田, 一枝, 18??-".
    .replace(/,?\s*\(\s*\d{4}\s*[-–‒]\s*(\d{4}|\.{4})?\s*\)/g, '')
    .replace(/,\s*\d{2}[\d?]{2}\s*-\s*(\d{2}[\d?]{2})?\.?$/, '')
    .replace(/\.\s*(Auteur|Author|Éditeur|Editor|Traducteur|Translator|Préfacier|Illustrateur)\.?$/i, '')
    .replace(/\s*\((Publishing editor|Storywriter|Novelist|Poet|Writer|Author|Editor|Compiler|Translator)\)/gi, '')
    .replace(/\s+of the Fabian Society$/i, '')
    .replace(/(?<=\p{Ll})\d$/u, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  // A CJK name inverted with a comma: "藤田, 一枝" → "藤田一枝".
  s = s.replace(/^(\p{Script=Han}+),\s*(\p{Script=Han}+)$/u, '$1$2');
  // A personal heading still inverted: "Minkevičius, Antanas" → "Antanas Minkevičius"; a title fragment
  // after it ("Hint, Aadu. Vatku tōbilas") is dropped. Place headings ("Moscow, Russia. …") stay.
  const inverted = s.match(/^(\p{Lu}[\p{L}'’-]+(?: \p{Lu}[\p{L}'’-]+)?), (?:Mrs\.? )?(\p{Lu}[\p{L}'’-]*\.?(?: \p{Lu}[\p{L}'’-]*\.?){0,3})(?:\. \p{Lu}[\p{L}\s'’-]+)?$/u);
  if (inverted && !PLACE_QUALIFIER.test(inverted[2]) && !isCorporate(s)) {
    s = isEastAsianSurname(inverted[1]) ? `${inverted[1]} ${inverted[2]}` : `${inverted[2]} ${inverted[1]}`;
  }
  if (/^\p{Script=Latin}/u.test(s) && !isCorporate(s) && !/\p{Script=Han}|\p{Script=Hangul}/u.test(s)) {
    // Initials without full stops or spaces: "H Poogelmann", "A.S.Nemzer" → "H. Poogelmann", "A. S. Nemzer".
    s = s.replace(/(^|\s)([A-DF-NP-TV-Z])(?=\s\p{Lu}\p{Ll})/gu, '$1$2.');
    // After another initial any letter is an initial: "T. E Solodkov", "A. S TSvetko", "F. Safari J".
    s = s.replace(/(?<=\p{Lu}\.\s)(\p{Lu})(?=\s\p{Lu})/gu, '$1.').replace(/(?<=\s\p{Lu}\p{Ll}+\s)(\p{Lu})$/u, '$1.');
    s = s.replace(/(?<=(^|[\s.])\p{Lu}\p{Ll}?)\.(?=\p{Lu})/gu, '. ');
  }
  s = s
    .replace(/^(eds?\.?|edited by|by)\s+/i, '')
    .replace(/^jr\.?\s+(.+)$/i, '$1 Jr.')
    .replace(/^ĸ\./, 'K.')
    .replace(/^(\p{Ll})\.(?=\s|\p{Lu})/u, (_, c) => `${c.toUpperCase()}.`)
    .replace(/^the\s/, 'The ')
    .replace(/^([\p{L}.]+) \(Social scientist\) /u, '$1 ');
  const given = s.match(/^(\p{Ll}[\p{Ll}\p{M}'’ -]*)\s(\p{Lu}\p{Ll}+)$/u);
  if (given && isEastAsianSurname(given[2]) && isSyllabic(given[1])) {
    const g = given[1].replace(/\s+/g, '');
    s = `${given[2]} ${g.charAt(0).toUpperCase()}${g.slice(1)}`;
  }
  if (/^\p{Ll}/u.test(s) && /^\p{Script=Latin}/u.test(s) && !LOWER_START.test(s)) s = s.charAt(0).toUpperCase() + s.slice(1);
  return s || null;
}

function displayAuthorName(name, alternates, { eastAsian, showNative }) {
  let n = formatAuthor(name, eastAsian);
  if (NON_LATIN.test(n)) {
    const latin = alternates.map((a) => formatAuthor(a, eastAsian)).find((a) => !NON_LATIN.test(a) && /\p{L}/u.test(a) && !/\d/.test(a));
    const roman = latin ? fullerForm(latin, alternates) : romanise(n);
    return `${roman} (${n})`;
  }
  n = fullerForm(n, alternates);
  if (showNative) {
    const native = alternates.find((a) => NON_LATIN.test(a));
    if (native) return `${n} (${formatAuthor(native)})`;
  }
  return n;
}

/**
 * Personal author names from a title page's statement of responsibility ("by V. I. Lenin"),
 * accepted only when every part reads as a name; editors and translators are ignored.
 */
export function authorsFromStatement(statement) {
  if (!statement) return [];
  const main = String(statement).split(/[;\[]/)[0].replace(TIES, '').trim();
  if (/translat|edit|compil|introduc|preface|foreword|herausg|hrsg|übers|trad|comp\.|ed\.|with\b|commission|committee|board/i.test(main)) return [];
  const body = main.replace(/^(written\s+)?(by|von|par|di|de|av|door)\s+/i, '').replace(/[.,]+$/, '').trim();
  const parts = body.split(/\s*(?:,\s*and\s+|\s+and\s+|\s+und\s+|\s+et\s+|\s*&\s*|,\s*)\s*/).filter(Boolean);
  const isName = (p) => {
    const words = p.split(/\s+/);
    return words.length >= 2 && words.length <= 5 && p.length < 50 && words.every((w) => /^(\p{Lu}|[a-z]{1,3}$)/u.test(w)) && /^\p{Lu}/u.test(p);
  };
  return parts.length && parts.every(isName) ? parts : [];
}

/** Names a statement of responsibility credits as translator or editor rather than author. */
export function secondaryNames(statement) {
  const s = String(statement ?? '').replace(TIES, '');
  const found = [];
  for (const m of s.matchAll(/(?:translat\w*|edit\w*|compil\w*)(?:\s+\w+)*?\s+by\s+([^;\]\[]+)/gi)) found.push(m[1]);
  return found.join(' ').toLowerCase();
}

// ---------------------------------------------------------------------------
// Duplicate editions
// ---------------------------------------------------------------------------

/** Title key ignoring case, punctuation and a leading article. */
export const titleKey = (s) => slug(s).replace(/^(the|a|an) /, '');

const nameTokens = (names) =>
  new Set((names ?? []).flatMap((n) => slug(n).split(/[\s-]+/)).filter((w) => w.length > 1 && !/^\d+$/.test(w)));

const GENERIC_WORDS = new Set(
  'selected collected complete works writings speeches articles letters poems stories essays volume volumes vol book part edition other short three two four five'.split(' '),
);

/**
 * Within one publisher and year, an identical title identifies the book unless the title is
 * purely generic ("Selected Works in Three Volumes", "Poems"), where the author decides.
 */
const isDistinctive = (key) => key.split(' ').some((w) => w.length > 1 && !/^\d+$/.test(w) && !MINOR_WORDS.has(w) && !GENERIC_WORDS.has(w));

/** Author lists agree if either is empty or they share a name token ("Li-po Chou" ~ "Libo Chou"). */
export const authorsOverlap = (a, b) => overlaps(nameTokens(a), nameTokens(b));

const languageSet = (language) => new Set(language === 'Not recorded' ? [] : language.split(', '));

/** Two token sets agree if either is empty or they overlap ("Li-po Chou" ~ "Libo Chou"; "English" ~ "English, Chinese"). */
function overlaps(x, y) {
  if (!x.size || !y.size) return true;
  for (const t of x) if (y.has(t)) return true;
  return false;
}

/**
 * Collapses records of the same edition: same year and title (with or without its subtitle, and
 * ignoring a leading article), with compatible authors and languages. Compatibility is checked
 * against the whole group, so a record with no author cannot bridge two different authors'
 * books of the same title. Distinctive titles merge even when the author names share nothing,
 * which covers romanisation variants ("Zhao Shuli" / "Shu-li Chao"). Returns groups of records.
 */
export function groupDuplicates(records) {
  // Records with authors first, so author-less records join an existing group rather than seed one.
  const ordered = [...records].sort((a, b) => (b.authors?.length ? 1 : 0) - (a.authors?.length ? 1 : 0));
  const groups = [];
  const index = new Map(); // "year|titleKey" → groups containing a record with that key
  for (const r of ordered) {
    const keys = [...new Set([titleKey(r.title), titleKey(`${r.title} ${r.subtitle ?? ''}`)])].map((k) => `${r.year ?? ''}|${k}`);
    const authors = nameTokens(r.authors);
    const langs = languageSet(r.language);
    const candidates = [...new Set(keys.flatMap((k) => index.get(k) ?? []))];
    const distinctive = isDistinctive(titleKey(r.title));
    // A long title by the same author in the same year is the same book even when one record's
    // language is wrong ("Die Leninwerke" catalogued as Russian); short titles such as "Lenin"
    // may be genuine editions in two languages.
    const long = titleKey(r.title).split(' ').length >= 3 || /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{4,}/u.test(r.title);
    // The same page count and a shared author also mark one book under two language tags
    // ("Tuskloe zoloto", 126 pages, as Russian and as Belarusian), provided the title has an
    // ordinary word in it: a name alone ("Rudolf Tobias") is the same in parallel editions.
    const pages = Number(r.pages) || 0;
    const wordy = /(^|\s)\p{Ll}{3,}/u.test(r.title);
    const samePages = (g) => pages > 0 && wordy && [...g.pages].some((p) => Math.abs(p - pages) <= 2);
    const sharedAuthor = (g) => authors.size > 0 && g.authors.size > 0 && overlaps(g.authors, authors);
    let group = candidates.find(
      (g) =>
        (distinctive || overlaps(g.authors, authors)) &&
        (overlaps(g.langs, langs) || ((long || samePages(g)) && sharedAuthor(g))),
    );
    if (!group) {
      group = { records: [], authors: new Set(), langs: new Set(), pages: new Set() };
      groups.push(group);
    }
    if (pages) group.pages.add(pages);
    group.records.push(r);
    for (const t of authors) group.authors.add(t);
    for (const l of langs) group.langs.add(l);
    for (const k of keys) {
      if (!index.has(k)) index.set(k, []);
      if (!index.get(k).includes(group)) index.get(k).push(group);
    }
  }
  return groups.map((g) => g.records);
}

/** Source citations for an edition: Open Library, plus WorldCat and LoC where known. */
export function catalogueSources(ed) {
  const oclc = ed.oclc_numbers?.[0];
  const lccn = ed.lccn?.[0]?.replace(/\s+/g, '');
  return [
    { title: `Open Library edition ${ed.key.split('/').pop()}`, url: `${OL}${ed.key}` },
    ...(oclc ? [{ title: `WorldCat record (OCLC ${oclc})`, url: `https://search.worldcat.org/title/${oclc}` }] : []),
    ...(lccn ? [{ title: `Library of Congress record (LCCN ${lccn})`, url: `https://lccn.loc.gov/${lccn}` }] : []),
  ];
}

export const describeEdition = (ed) =>
  `${(ed.publishers ?? []).join('/')}, ${(ed.publish_places ?? []).join('/') || '?'}, ${ed.publish_date ?? 'n.d.'} <${OL}${ed.key}>`;

// ---------------------------------------------------------------------------
// Hand-written YAML patching
// ---------------------------------------------------------------------------

/**
 * Sets `verified: true` and replaces `sources` on items of a top-level YAML list
 * (e.g. `titles:` or `works:`) without disturbing the rest of the hand-written file.
 * `updates` are { index, sources } where index is the item's position in that list.
 */
export function patchListFile(file, listKey, updates) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const listStart = lines.findIndex((l) => l === `${listKey}:`);
  if (listStart < 0) throw new Error(`No top-level "${listKey}:" in ${file}`);
  let listEnd = lines.findIndex((l, i) => i > listStart && /^\S/.test(l) && !l.startsWith('#'));
  if (listEnd < 0) listEnd = lines.length;
  const starts = [];
  for (let i = listStart + 1; i < listEnd; i++) if (/^  - /.test(lines[i])) starts.push(i);

  for (const { index, sources } of [...updates].sort((a, b) => b.index - a.index)) {
    const start = starts[index];
    let end = starts[index + 1] ?? listEnd;
    while (end > start + 1 && (/^\s*$/.test(lines[end - 1]) || /^\s*#/.test(lines[end - 1]))) end--;
    const keep = [];
    const block = lines.slice(start, end);
    for (let i = 0; i < block.length; i++) {
      if (/^    verified:/.test(block[i])) continue;
      if (/^    sources:/.test(block[i])) { while (/^      /.test(block[i + 1] ?? '')) i++; continue; }
      keep.push(block[i]);
    }
    const added = ['    verified: true', '    sources:', ...sources.flatMap((s) => [
      `      - title: ${JSON.stringify(s.title)}`, `        url: ${s.url}`,
    ])];
    lines.splice(start, end - start, ...keep, ...added);
  }
  writeFileSync(file, lines.join('\n'));
}
