/**
 * Finds the spellings under which the catalogue credits each author, and adds them to the author's
 * alternate_names so that their page lists those editions: "M. I. Kalinin" or "Mikhail Ivanovich
 * Kalinin" for "Mikhail Kalinin".
 *
 * A credit matches when its surname is the author's and its first name is either the author's
 * first name or that name's initial (followed only by other initials). "Robert Williams" never
 * matches "Raymond Williams", and a spelling already claimed by another author is left alone.
 *
 *   node scripts/find-author-spellings.mjs           # dry run: print what would be added
 *   node scripts/find-author-spellings.mjs --write   # add the spellings
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { ROOT } from './lib/openlibrary.mjs';

const WRITE = process.argv.includes('--write');
const AUTHORS = join(ROOT, 'data', 'authors');
const MAX_NEW = 8;
// Spellings that pass the rules but name someone else (another patronymic, a namesake).
const REJECTED = new Set([
  'Aleksandr Fedorovich Bogdanov', 'Anatoliǐ Frolovich Kalinin', 'Blas pseud Roca', 'Brian (Ed. ) Simon',
  'Carlos Coutinho', 'Georgi Mitrev Markov', 'Leonid Dmitrievich Sobolev', 'Manuel Denis',
  'Mikhail Pavlovich Alekseev', 'Nguyen Thi', 'Nguyễn Đình', 'Richard Kozul-Wright', 'Joaquim Gomes',
  'Vsevolod Mikhaĭlovich Ivanov', 'Vsevolod Mikhaǐlovich Ivanov', 'Vsevolod Nikandrovich Ivanov', 'Wang Hui-ming', 'Hsiao Kuan-hung',
  'Khrushchev, Nikita Sergeevich 1894-1971; Central Committee', "Yang Shang-K'uei",
  'Robert Farris Thompson', 'Sergio García Ramírez', 'Mikhail Ivanovich Tikhomirov', 'Mikhail Ivanovich (Journalist) Tikhomirov',
  'Nikolaĭ Fedorovich Kuznetsov', "Nikolai Vasil'evich Kuznetsov", 'Vladimir Vladimirovich Pavlov', 'Vladimir Grigorʹevich Pavlov',
  'Vladimir Ivanovich Pavlov', 'Pavel Mikhailovich Iudin', 'John Foster', 'John Charles Smith', 'James Stewart Allen',
  'Nikolai Ivanovich Gavrilov', 'Ivan Ivanovich Frolov', "Kim Ch'ŏl", 'G.* Malenkov', 'Ashot Martirosovich.· Arzumanian',
]);

/** Lower-case words without accents; "Lenin, V. I." → ["v", "i", "lenin"]. */
function words(name) {
  let n = String(name).replace(/,?\s*\(?\d{4}\s*-\s*(\d{4})?\)?\.?/g, '').trim();
  const parts = n.split(/\s*,\s*/);
  if (parts.length === 2) n = `${parts[1]} ${parts[0]}`;
  return n.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’ʹʼʺ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean).map(fold);
}

/**
 * Romanisations of one Russian name, compared as one: library "Pokrovskiĭ", "Mintz", "Leont'ev"
 * and English "Pokrovsky", "Mints", "Leontyev".
 */
function fold(w) {
  return w
    .replace(/(sk|ck|tsk)(ii|iy|ij|y)$/, '$1y')
    .replace(/([^aeiou])(iev|yev|jev)$/, '$1ev')
    .replace(/tz/g, 'ts')
    .replace(/x/g, 'ks')
    .replace(/yu/g, 'iu')
    .replace(/ya/g, 'ia');
}
const key = (name) => words(name).join(' ');

/**
 * True when the credit's words name the author: the same surname and a compatible first name.
 *
 * - "Mikhail Ivanovich Kalinin" for "Mikhail Kalinin": the same first name; a middle name
 *   (a patronymic) is allowed only when the author's name has no middle part of its own, and an
 *   added middle initial is not ("Georgi V. Dimitrov" may be someone else).
 * - "M. I. Kalinin": initials that agree with the author's names; a lone initial ("M. Davis") only
 *   when no other first name is found with that surname.
 */
function sameAuthor(author, credit, surnameFirstNames) {
  if (author.length < 2 || credit.length < 2) return false;
  if (author.at(-1) !== credit.at(-1) || author.at(-1).length < 3) return false;
  const given = author.slice(0, -1);
  const [first, ...middle] = credit.slice(0, -1);
  if (first.length > 1) {
    if (first !== given[0]) return false;
    if (!middle.length) return true;
    if (given.length === 1) return middle.every((w) => w.length > 1);
    // A longer author name: every middle part must be the author's own (or its initial).
    return middle.every((w, i) => given[i + 1] && (w === given[i + 1] || w === given[i + 1][0]));
  }
  // Initials only, each agreeing with the author's given names in order.
  const initials = credit.slice(0, -1);
  if (!initials.every((w) => w.length === 1) || initials.length > given.length) return false;
  if (!initials.every((w, i) => given[i][0] === w)) return false;
  return initials.length > 1 || (surnameFirstNames.get(author.at(-1))?.size ?? 0) <= 1;
}

// Catalogue credits and their spellings.
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const spellings = new Map(); // key → { words, raw: Set }
for (const file of walk(join(ROOT, 'data', 'catalogues'))) {
  for (const t of yaml.load(readFileSync(file, 'utf8')).titles ?? []) {
    for (const a of [...(t.authors ?? []), ...(t.editors ?? [])]) {
      if (/&|\band\b|\.\s+\p{Lu}\p{Ll}+\.\s|\(\s*[^)]*$/u.test(a)) continue; // joint names, title fragments
      const k = key(a);
      if (!k || REJECTED.has(a)) continue;
      const e = spellings.get(k) ?? { words: words(a), raw: new Set(), n: 0 };
      e.raw.add(a);
      e.n++;
      spellings.set(k, e);
    }
  }
}
const surnameFirstNames = new Map();
for (const e of spellings.values()) {
  const w = e.words;
  if (w.length >= 2 && w[0].length > 1) surnameFirstNames.set(w.at(-1), new Set([...(surnameFirstNames.get(w.at(-1)) ?? []), w[0]]));
}
const bySurname = new Map();
for (const [k, e] of spellings) bySurname.set(e.words.at(-1), [...(bySurname.get(e.words.at(-1)) ?? []), [k, e]]);

// Every author's names, so that no spelling is given to two authors.
const authors = readdirSync(AUTHORS).filter((f) => /\.ya?ml$/.test(f)).map((f) => {
  const data = yaml.load(readFileSync(join(AUTHORS, f), 'utf8'));
  return { file: f, data, names: [data.name, ...(data.alternate_names ?? [])] };
});
const owner = new Map();
for (const a of authors) for (const n of a.names) owner.set(key(n), a.file);

let changed = 0;
let added = 0;
for (const a of authors) {
  const own = new Set(a.names.map(key));
  const candidates = new Map();
  for (const n of a.names) {
    const w = words(n);
    for (const [k, e] of bySurname.get(w.at(-1)) ?? []) {
      if (own.has(k) || (owner.has(k) && owner.get(k) !== a.file)) continue;
      if (sameAuthor(w, e.words, surnameFirstNames)) candidates.set(k, e);
    }
  }
  // Two different authors may both match a spelling ("A. Ghosh"); such spellings are left alone.
  const fresh = [...candidates].filter(([k]) => !authors.some((b) => b !== a && b.names.some((n) => sameAuthor(words(n), spellings.get(k).words, surnameFirstNames))));
  if (!fresh.length) continue;
  const add = fresh.sort((x, y) => y[1].n - x[1].n).slice(0, MAX_NEW).map(([, e]) => [...e.raw].find((r) => words(r).at(-1) === e.words.at(-1)) ?? [...e.raw][0]);
  changed++;
  added += add.length;
  console.log(`${a.data.name}: + ${add.join(' | ')}`);
  if (WRITE) {
    a.data.alternate_names = [...(a.data.alternate_names ?? []), ...add];
    // Keep the usual key order: alternate names right after the name.
    const { name, alternate_names, ...rest } = a.data;
    writeFileSync(join(AUTHORS, a.file), yaml.dump({ name, alternate_names, ...rest }, { lineWidth: 96, noRefs: true }));
  }
}
console.log(`\n${changed} authors, ${added} spellings ${WRITE ? 'added' : 'to add'}`);
