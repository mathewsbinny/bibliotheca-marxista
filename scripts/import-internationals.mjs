/**
 * Lists the works of the communist internationals (data/internationals/*.yaml) from Open Library:
 * editions credited to the international or one of its bodies (`credits`), printed while it was
 * active. Works its own presses published are imported with the publishers and need no listing.
 *
 *   node scripts/import-internationals.mjs           # dry run: print counts
 *   node scripts/import-internationals.mjs --write   # rewrite each file's Open Library works
 *
 * Works listed by hand (any work without an Open Library edition among its sources) are kept.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { OL, ROOT, clean, editionsByWork, formatTitle, getJSON, isEnglishTitle, slug, yearOf } from './lib/openlibrary.mjs';
import { normalizePublisher, UNKNOWN_PUBLISHER } from './lib/publisher-names.mjs';

const DIR = join(ROOT, 'data', 'internationals');
const WRITE = process.argv.includes('--write');
const LANGUAGES = {
  eng: 'English', fre: 'French', ger: 'German', spa: 'Spanish', rus: 'Russian', chi: 'Chinese', ita: 'Italian',
  por: 'Portuguese', pol: 'Polish', cze: 'Czech', hun: 'Hungarian', dut: 'Dutch', swe: 'Swedish', nor: 'Norwegian',
  dan: 'Danish', fin: 'Finnish', yid: 'Yiddish', jpn: 'Japanese', bul: 'Bulgarian', rum: 'Romanian', gre: 'Greek',
  ukr: 'Ukrainian', srp: 'Serbian', hrv: 'Croatian', slo: 'Slovak', tur: 'Turkish', ara: 'Arabic', hin: 'Hindi',
  per: 'Persian', vie: 'Vietnamese', kor: 'Korean', heb: 'Hebrew', lit: 'Lithuanian', lav: 'Latvian', est: 'Estonian',
  esp: 'Esperanto', epo: 'Esperanto', cat: 'Catalan', nep: 'Nepali', ben: 'Bengali', tam: 'Tamil', mul: 'Multiple languages',
};

/** True when a catalogue's author heading is the credited body or one of its subdivisions ("Communist International. Congress (2nd : 1920)"). */
function isCredited(heading, credits) {
  const h = heading.normalize('NFC').toLowerCase().trim();
  return credits.some((c) => {
    const k = c.normalize('NFC').toLowerCase();
    return slug(h) === slug(k) || (h.startsWith(k) && /^\s*[.(,]/.test(h.slice(k.length)));
  });
}

const thisYear = new Date().getFullYear();
for (const file of readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort()) {
  const path = join(DIR, file);
  const data = yaml.load(readFileSync(path, 'utf8'));
  const credits = [data.name, ...(data.credits ?? [])];
  const [from, to] = [data.founded, (data.dissolved ?? thisYear) + 1];

  // Works whose author headings name the international.
  const works = new Map();
  for (const credit of credits) {
    const params = new URLSearchParams({ author: `"${credit}"`, fields: 'key,author_name', limit: '1000' });
    const res = await getJSON(`${OL}/search.json?${params}`);
    for (const d of res.docs ?? []) {
      const names = d.author_name ?? [];
      if (!names.some((n) => isCredited(n, credits))) continue;
      works.set(d.key, names.filter((n) => !isCredited(n, credits)));
    }
  }

  const found = new Map();
  for (const [key, people] of works) {
    for (const ed of await editionsByWork(key)) {
      const year = yearOf(ed.publish_date);
      if (!year || year < from || year > to) continue; // later reprints belong to their own publishers
      const title = clean(ed.title);
      if (!title) continue;
      const langs = (ed.languages ?? []).map((l) => l.key.split('/').pop()).filter((c) => c !== 'und');
      const language = langs.length ? [...new Set(langs.map((c) => LANGUAGES[c] ?? c))].join(', ') : undefined;
      const english = isEnglishTitle(title, language);
      const publisher = normalizePublisher(clean(ed.publishers?.[0]) ?? UNKNOWN_PUBLISHER);
      const place = clean(ed.publish_places?.[0])?.replace(/^\[|\]$/g, '');
      const olid = ed.key.split('/').pop();
      const work = {
        title: formatTitle(title, english, language),
        subtitle: formatTitle(clean(ed.subtitle), english, language),
        authors: people,
        year,
        language,
        publisher,
        place: place && !/^s\.\s*l\.?$/i.test(place) ? place : undefined,
        links: ed.ocaid ? [{ label: 'Scan (Internet Archive)', url: `https://archive.org/details/${ed.ocaid}` }] : [],
        sources: [{ title: `Open Library edition ${olid}`, url: `${OL}/books/${olid}` }],
      };
      for (const k of Object.keys(work)) if (work[k] === undefined || (Array.isArray(work[k]) && !work[k].length)) delete work[k];
      const id = [slug(work.title), year, slug(publisher)].join('|');
      const prev = found.get(id);
      if (!prev || (!prev.links && work.links)) found.set(id, work);
    }
  }

  const byHand = (data.works ?? []).filter((w) => !(w.sources ?? []).some((s) => /openlibrary\.org\/books\//.test(s.url ?? '')));
  const listed = [...found.values()].sort((a, b) => a.year - b.year || a.title.localeCompare(b.title));
  console.log(`${data.name}: ${works.size} works credited, ${listed.length} editions ${from}–${to}, ${byHand.length} listed by hand`);
  if (WRITE) {
    data.works = [...byHand, ...listed];
    writeFileSync(path, yaml.dump(data, { lineWidth: 96, noRefs: true }));
  }
}
