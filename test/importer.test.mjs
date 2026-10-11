// The importer: which house an imprint is given to, the screening of authors outside the catalogue's
// scope, and the clean-up of publisher names.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { normalizePublisher, UNKNOWN_PUBLISHER } from '../scripts/lib/publisher-names.mjs';
import { notLeftCredit, screenTitle } from '../scripts/lib/not-left.mjs';
import { HOUSES, marxistRules } from '../scripts/lib/marxist-houses.mjs';
import { marc21Original, marc21People, unimarcOriginal, unimarcPeople } from '../scripts/lib/sources.mjs';
import { ROOT } from './fixture.mjs';

// imprint | place | year → the house it goes to ('' for none). Asked of the importer in one run.
const CASES = [
  // Places separate the foreign-languages presses of Moscow, Beijing, Pyongyang and Hanoi.
  ['Foreign Languages Publishing House|Moscow|1955', 'foreign-languages-publishing-house-moscow'],
  ['Foreign Languages Press|Peking|1966', 'foreign-languages-press-beijing'],
  ['Foreign Languages Publishing House|Pyongyang|1975', 'foreign-languages-publishing-house-pyongyang'],
  ['Foreign Languages Publishing House|Hanoi|1970', 'foreign-languages-publishing-house-hanoi'],
  ['Kultura|Beograd|1960', 'kultura-belgrade'],
  ['Kultura|Skopje|1960', 'kultura-skopje'],
  ['Government Information Service|St. George\'s|1981', 'grenada-government-information-service'],
  ['Government Information Service|St. George, Utah|1981', ''],
  // Romanisations: DIN 1460 (the German catalogues), Cyrillic, and pinyin written syllable by syllable.
  ['Molodaja gvardija|Moskva|1975', 'molodaia-gvardiia'],
  ['Izdat. CK VLKSM Molodaja Gvardija|Moskva|1975', 'molodaia-gvardiia'],
  ['Chudožestvennaja literatura|Leningrad|1975', 'khudozhestvennaia-literatura'],
  ['Наука|Москва|1975', 'nauka-moscow'],
  ['Izdatel\'stvo "Nauka", Leningradskoe otdelenie|Leningrad|1975', 'nauka-moscow'],
  ['Prosveščenie|Moskva|1975', 'prosveshchenie'],
  ['Shang hai ren min chu ban she|Shang hai|1975', 'shanghai-peoples-publishing-house'],
  ['Ulsyn Hevleliin Gazar|Ulaanbaatar|1970', 'ulsyn-khevleliin-gazar'],
  ['Kuraz Asatami Derejet|Addis Ababa|1980', 'kuraz-publishing-agency'],
  ['Izdavačko preduzeće "Veselin Masleša,"|Sarajevo|1970', 'veselin-maslesa'],
  // Progress's editions in other languages, and an unrelated Progreso elsewhere.
  ['Progreso|Moscú|1978', 'progress-publishers'],
  ['Éditions du Progrès|Moscou|1975', 'progress-publishers'],
  ['Progreso|Barcelona|1920', ''],
  // A house's years: Feltrinelli's political years end in 1980.
  ['Feltrinelli|Milano|1960', 'feltrinelli'],
  ['Feltrinelli|Milano|2005', ''],
  ['Lawrence & Wishart|London|1950', 'lawrence-and-wishart'],
];

describe('assigning imprints to houses', () => {
  const out = execFileSync(process.execPath, [join(ROOT, 'scripts', 'import-openlibrary.mjs'), '--test-match', ...CASES.map(([c]) => c)], { encoding: 'utf8' });
  const got = new Map(out.trim().split('\n').map((l) => l.split(' => ')).map(([c, h]) => [c, h === '(none)' ? '' : h]));
  for (const [imprint, house] of CASES) {
    test(`${imprint} → ${house || 'no house'}`, () => assert.equal(got.get(imprint), house));
  }
});

describe('the table of Marxist and socialist-state houses', () => {
  const rules = marxistRules();
  test('gives each house one rule, with a unique id', () => {
    assert.equal(new Set(HOUSES.map(([id]) => id)).size, HOUSES.length);
    assert.equal(rules.length, HOUSES.length);
  });
  for (const [id, name, , , , , , [from, until]] of HOUSES) {
    test(`${id}: matches its own name, within sensible years`, () => {
      const rule = rules.find((r) => r.id === id);
      assert.ok(rule.match.test(name), `${name} matches`);
      assert.ok(from <= until && from >= 1800 && until <= 2030, `${from}–${until}`);
    });
  }
});

describe('screening authors outside the catalogue', () => {
  test('recognises a fascist under any form of the name', () => {
    for (const credit of ['Adolf Hitler', 'Hitler, Adolf', 'Hitler, Adolf, 1889-1945']) assert.equal(notLeftCredit(credit)?.kind, 'fascist');
    assert.equal(notLeftCredit('Karl Marx'), undefined);
  });

  test("keeps the works of an author's left years only", () => {
    assert.equal(notLeftCredit('Arthur Koestler', 1938), undefined);
    assert.equal(notLeftCredit('Arthur Koestler', 1950)?.name, 'Arthur Koestler');
    assert.equal(notLeftCredit('Arthur Koestler'), undefined, 'an undated title is kept');
  });

  test('drops a title by one of them, keeps a left title that only names one', () => {
    assert.equal(screenTitle({ title: 'The Greater Britain', authors: ['Oswald Mosley'], year: 1932 }), null);
    // Hitler is credited by library catalogues as the author of Left exposés of him ("Hitler, der
    // Eroberer"): his name goes, the title stays.
    assert.deepEqual(screenTitle({ title: 'Hitler, der Eroberer', authors: ['Adolf Hitler'], year: 1933 })?.authors, []);
    // Credited only as the subject of a left publication: the credit goes, the title stays.
    const t = screenTitle({ title: 'The Reichstag Fire Trial', authors: ['Hermann Göring', 'Georgi Dimitrov'], year: 1934 });
    assert.deepEqual(t?.authors, ['Georgi Dimitrov']);
    const marx = { title: 'Capital', authors: ['Karl Marx'] };
    assert.equal(screenTitle(marx), marx);
  });
});

describe('cleaning publisher names', () => {
  const cases = {
    'oxford university press': 'Oxford University Press',
    'EDITORIAL PROGRESO': 'Editorial Progreso',
    'ÉDITIONS SOCIALES': 'Éditions Sociales',
    "l'Harmattan": "L'Harmattan",
    'Progress Publishers, 1975': 'Progress Publishers',
    ' [Foreign Languages Press] ': 'Foreign Languages Press',
    'Verlag Neuer Weg, etc.': 'Verlag Neuer Weg',
    'Lawrence & Wishart': 'Lawrence & Wishart',
  };
  for (const [raw, clean] of Object.entries(cases)) test(`${JSON.stringify(raw)} → ${clean}`, () => assert.equal(normalizePublisher(raw), clean));
  test('marks a placeholder as unrecorded', () => {
    for (const raw of ['s.n.', '[s.n.]']) assert.equal(normalizePublisher(raw), UNKNOWN_PUBLISHER);
  });
});

describe("library records' people and original titles", () => {
  const field = (sub, ind1) => ({ ind1, sub });
  test('MARC 21: authors, translators and editors by their relators; other roles left out', () => {
    const p = marc21People({
      100: [field({ a: ['Lenin, V. I.,'], d: ['1870-1924'] })],
      700: [
        field({ a: ['Dutt, Clemens,'], e: ['translator.'] }),
        field({ a: ['Hanna, George'], 4: ['edt'] }),
        field({ a: ['Kiseleva, L. A.'] }),
        field({ a: ['Someone, Illustrating'], 4: ['ill'] }),
        field({ a: ['Engels, Friedrich'], t: ['Anti-Dühring'] }),
      ],
    });
    assert.deepEqual(p, { creators: ['Lenin, V. I.,', 'Kiseleva, L. A.'], translators: ['Dutt, Clemens,'], editors: ['Hanna, George'] });
  });
  test('MARC 21: the original title of a translation, and not the uniform title of another book', () => {
    assert.equal(marc21Original({ 240: [field({ a: ['Gosudarstvo i revoli︠u︡t︠s︡ii︠a︡.'], l: ['English'] })] }, false), 'Gosudarstvo i revoli︠u︡t︠s︡ii︠a︡');
    assert.equal(marc21Original({ 765: [field({ t: ['Fiziko-chimija kolloidov <russ.>'] })] }, false), 'Fiziko-chimija kolloidov');
    assert.equal(marc21Original({ 240: [field({ a: ['Capital.'] })] }, false), undefined, 'not said to be a translation');
    assert.equal(marc21Original({ 240: [field({ a: ['Works.'] })], 41: [] }, true), undefined, 'a collective title');
    assert.equal(marc21Original({ 500: [field({ a: ['Translation of: Detskaia bolezn’ “levizny” v kommunizme.'] })] }, false), 'Detskaia bolezn’ “levizny” v kommunizme');
  });
  test('UNIMARC: role codes, and the original title', () => {
    const f = {
      700: [field({ a: ['Mickiewicz'], b: ['Adam'], 4: ['070'] })],
      702: [field({ a: ['Dimitrova'], b: ['Blaga'], 4: ['730'] }), field({ a: ['Dinekov'], b: ['Petʺr'], 4: ['340'] }), field({ a: ['Anon'], b: ['A.'] })],
      454: [field({ t: ['Pan Tadeusz'] })],
    };
    const name = (x) => [x.sub.a?.[0], x.sub.b?.[0]].filter(Boolean).join(', ');
    assert.deepEqual(unimarcPeople(f, name), { creators: ['Mickiewicz, Adam'], translators: ['Dimitrova, Blaga'], editors: ['Dinekov, Petʺr'] });
    assert.equal(unimarcOriginal(f, true), 'Pan Tadeusz');
  });
});
