#!/usr/bin/env node
/**
 * Verifies the first-edition bibliographies in data/authors/*.yaml against Open Library.
 *
 *   node scripts/verify-authors.mjs            # dry run: report only
 *   node scripts/verify-authors.mjs --write    # also mark verified works and add their sources
 *
 * A work is verified when a library-catalogued edition (MARC record, OCLC number or LCCN) has a
 * matching title, the same year, and an imprint that names the stated publisher. Works that
 * cannot be confirmed are listed in reports/author-review.md with the closest records found, so
 * wrong years or publishers can be corrected by hand.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import {
  ROOT, catalogueSources, clean, describeEdition, editionsForTitle, isCatalogued, patchListFile,
  requestCount, slug, surname, titlesMatch, yearOf,
} from './lib/openlibrary.mjs';

const AUTHORS = join(ROOT, 'data', 'authors');
const WRITE = process.argv.includes('--write');
// Only these authors (--only=eric-hobsbawm,mike-davis): checking every author takes the better
// part of two days at Open Library's pace.
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice('--only='.length).split(',').filter(Boolean);

/** Distinctive words of a publisher name, e.g. "D. Appleton and Company" → ["appleton"]. */
const STOP = new Set(['and', 'the', 'company', 'press', 'publishers', 'publishing', 'books', 'house', 'ltd', 'inc', 'sons', 'limited', 'verlag', 'der', 'des', 'von', 'und']);
const keyWords = (name) => slug(name).split(' ').filter((w) => w.length > 2 && !STOP.has(w));

/**
 * The stated publisher appears in the edition's imprint. Words are compared by their first six
 * letters, so inflections and catalogue typos still match ("literarisches Comptoir" ~
 * "literarischen Comptrois").
 */
function publisherMatches(stated, ed) {
  const words = keyWords(stated);
  const imprintWords = slug((ed.publishers ?? []).join(' ')).split(' ');
  const stem = (w) => w.slice(0, 6);
  if (!words.length) return slug((ed.publishers ?? []).join(' ')).includes(slug(stated));
  return words.some((w) => imprintWords.some((i) => stem(i) === stem(w)));
}

const report = [];
let verified = 0;
let total = 0;

const chosen = (f) => !ONLY || ONLY.includes(f.replace(/\.ya?ml$/, ''));
for (const file of readdirSync(AUTHORS).filter((f) => /\.ya?ml$/.test(f) && chosen(f)).map((f) => join(AUTHORS, f))) {
  const author = yaml.load(readFileSync(file, 'utf8'));
  const surnames = [...new Set([author.name, ...(author.alternate_names ?? [])].map(surname).filter((s) => /^[a-z]+$/.test(s)))];
  const patches = [];
  console.log(author.name);

  for (const [index, work] of author.works.entries()) {
    total++;
    let editions = [];
    for (const s of surnames) {
      editions = await editionsForTitle(work.title, s);
      if (editions.length) break;
    }
    if (!editions.length) editions = await editionsForTitle(work.title);

    const sameTitle = editions.filter((ed) => titlesMatch(work, { title: clean(ed.title) ?? '', subtitle: clean(ed.subtitle) }));
    const confirmed = sameTitle.filter((ed) => yearOf(ed.publish_date) === work.year && publisherMatches(work.publisher, ed) && isCatalogued(ed));

    if (confirmed.length) {
      verified++;
      const sources = [...new Map(confirmed.flatMap(catalogueSources).map((s) => [s.url, s])).values()].slice(0, 4);
      patches.push({ index, sources });
    } else {
      const earliest = sameTitle
        .filter((ed) => yearOf(ed.publish_date))
        .sort((a, b) => yearOf(a.publish_date) - yearOf(b.publish_date))
        .slice(0, 3);
      report.push(
        `- **${author.name}** — ${work.title} (${work.publisher}, ${work.year}): ` +
          (earliest.length ? `earliest catalogue records: ${earliest.map(describeEdition).join('; ')}` : 'no matching catalogue record found'),
      );
    }
  }
  if (WRITE && patches.length) patchListFile(file, 'works', patches);
}

mkdirSync(join(ROOT, 'reports'), { recursive: true });
writeFileSync(join(ROOT, 'reports', 'author-review.md'), [
  '# Author bibliographies — review report',
  '',
  `Generated ${new Date().toISOString().slice(0, 10)}. ${verified} of ${total} works verified.`,
  '',
  '## Not verified',
  '',
  ...report,
  '',
].join('\n'));

console.log(`\n${verified} of ${total} works verified; ${requestCount()} network requests.`);
console.log(WRITE ? 'Author files updated.' : 'Dry run — pass --write to update author files.');
console.log('Report: reports/author-review.md');
