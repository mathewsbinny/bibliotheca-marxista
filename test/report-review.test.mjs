// Readers' error reports reviewed: which become corrections, which are left for a maintainer, and
// how corrections apply to titles without changing their addresses.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import Database from 'better-sqlite3';
import * as yaml from 'js-yaml';
import { decide, proposedValue } from '../scripts/lib/report-review.mjs';
import { addReport, decideReport, openReports, reportsForReview } from '../server/reports.mjs';
import { applyCorrections } from '../src/lib/corrections.ts';
import { ROOT, makeFixture } from './fixture.mjs';

const record = {
  id: 'state-and-revolution-1970', href: '/book/progress/state-and-revolution-1970', publisherId: 'progress',
  title: 'The State and Revolution', authors: [{ name: 'V. I. Lenin', href: '/authors/lenin' }], year: 1970, language: 'English',
  links: [{ label: 'Scan (Internet Archive)', url: 'https://archive.org/details/staterev' }], sources: [{ title: 'OL1M' }], verified: true,
};
const report = (kind, message, extra = {}) => ({ id: 1, kind, message, href: record.href, title: record.title, record, others: {}, ...extra });
const applies = (d, set) => { assert.equal(d.action, 'apply', d.reason); assert.deepEqual(d.set, set); };
const manual = (d) => assert.equal(d.action, 'manual', `applied: ${d.summary}`);

describe('the proposed value', () => {
  test('quoted, or after "should be"', () => {
    assert.equal(proposedValue('The title should be “State and Revolution”'), 'State and Revolution');
    assert.equal(proposedValue('should be: State and Revolution.'), 'State and Revolution');
    assert.equal(proposedValue('"The State and Revolutoin" should be "The State and Revolution"'), 'The State and Revolution');
  });
  test('none when the report says more than one thing, or nothing plain', () => {
    assert.equal(proposedValue('should be State and Revolution. Also the year is wrong.'), undefined);
    assert.equal(proposedValue('This is wrong'), undefined);
  });
});

describe('reports that become corrections', () => {
  test('a year', () => applies(decide(report('date', 'Published in 1971, not 1970')), { year: 1971 }));
  test('a title, with its subtitle apart', () => applies(decide(report('title', 'Should be "The State and Revolution: The Marxist Theory of the State"')),
    { title: 'The State and Revolution', subtitle: 'The Marxist Theory of the State' }));
  test('an author replaced, or added', () => {
    applies(decide(report('author', 'Author should be "Vladimir Lenin"')), { authors: ['Vladimir Lenin'] });
    applies(decide(report('author', 'Missing author: Grigory Zinoviev')), { authors: ['V. I. Lenin', 'Grigory Zinoviev'] });
  });
  test('a language', () => applies(decide(report('language', 'This edition is in German')), { language: 'German' }));
  test('a broken link removed, or moved within its site', () => {
    applies(decide(report('link', 'https://archive.org/details/staterev is broken')), { links: [] });
    applies(decide(report('link', 'The scan moved: https://archive.org/details/staterev → https://archive.org/details/staterev2')),
      { links: [{ label: 'Scan (Internet Archive)', url: 'https://archive.org/details/staterev2' }] });
  });
  test('a duplicate: the poorer record goes', () => {
    const other = { ...record, id: 'the-state-and-revolution-1970', href: '/book/progress/the-state-and-revolution-1970', verified: false, sources: [] };
    const d = decide(report('duplicate', 'Same as /book/progress/the-state-and-revolution-1970', { others: { [other.href]: other } }));
    assert.equal(d.action, 'apply');
    assert.equal(d.id, other.id);
    assert.equal(d.remove, true);
  });
});

describe('reports left for a maintainer', () => {
  test('kinds that need judgement', () => {
    for (const kind of ['publisher', 'scope', 'other']) manual(decide(report(kind, 'Should be "X"')));
  });
  test('unsure, empty, long or vague reports', () => {
    manual(decide(report('date', 'Maybe 1971?')));
    manual(decide(report('date', '')));
    manual(decide(report('date', `1971 ${'x'.repeat(700)}`)));
    manual(decide(report('title', 'The title is wrong')));
    manual(decide(report('date', 'Published in the 1970s')));
    manual(decide(report('date', 'Either 1971 or 1972')));
  });
  test('a title sharing no word with the record, or an unlikely name', () => {
    manual(decide(report('title', 'Should be "Buy cheap watches"')));
    manual(decide(report('author', 'Author should be "visit https://spam.example"')));
  });
  test('a link to another site, and a duplicate that differs', () => {
    manual(decide(report('link', 'https://archive.org/details/staterev → https://elsewhere.example/staterev')));
    const other = { ...record, id: 'imperialism-1970', href: '/book/progress/imperialism-1970', title: 'Imperialism' };
    manual(decide(report('duplicate', 'Same as /book/progress/imperialism-1970', { others: { [other.href]: other } })));
  });
  test('a title no longer in the catalogue', () => manual(decide(report('date', '1971', { record: null }))));
});

describe('corrections', () => {
  const titles = [
    { id: 'a-1970', publisherId: 'p', title: 'A', year: 1970, authors: ['X'] },
    { id: 'b-1971', publisherId: 'p', title: 'B', year: 1971, authors: [] },
  ];
  test('replace fields, keep the id, and remove titles', () => {
    const { titles: out, orphans } = applyCorrections(titles, new Map([['p', [
      { id: 'a-1970', set: { year: 1975 } }, { id: 'a-1970', set: { title: 'A!' } }, { id: 'b-1971', remove: true }, { id: 'gone', set: { year: 1 } },
    ]]]));
    assert.deepEqual(out, [{ id: 'a-1970', publisherId: 'p', title: 'A!', year: 1975, authors: ['X'] }]);
    assert.deepEqual(orphans, ['p/gone']);
  });
});

describe('scripts/review-reports.mjs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reports-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  test('the server exports open reports with their records, and records decisions on open ones only', () => {
    const fixture = makeFixture();
    const db = openReports(join(dir, 'reports.sqlite'));
    try {
      const href = '/book/progress/capital-1965';
      addReport(db, { href, publisherId: 'progress', titleId: 'capital-1965', title: 'Capital', kind: 'duplicate', message: 'Same as /book/progress/state-and-revolution-1970' });
      const catalogue = new Database(fixture.dbFile, { readonly: true });
      const [open] = reportsForReview(db, catalogue);
      catalogue.close();
      assert.equal(open.record.title, 'Capital');
      assert.equal(open.record.publisherId, 'progress');
      assert.equal(open.others['/book/progress/state-and-revolution-1970'].title, 'The State and Revolution');
      assert.equal(decideReport(db, open.id, 'manual', 'Manual review: differ'), 1);
      assert.equal(decideReport(db, open.id, 'applied', 'again'), 0, 'a decided report is left alone');
      const again = new Database(fixture.dbFile, { readonly: true });
      assert.equal(reportsForReview(db, again).length, 0);
      again.close();
    } finally {
      db.close();
      fixture.cleanup();
    }
  });
  test('writes corrections, decisions and a summary', () => {
    writeFileSync(join(dir, 'open.json'), JSON.stringify([
      report('date', 'Published in 1971'), { ...report('scope', 'Not left @someone <b>'), id: 2 },
      { ...report('other', 'Write to me at reader@example.org or +44 20 7946 0958'), id: 3 },
    ]));
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'review-reports.mjs'), `--from=${join(dir, 'open.json')}`,
      `--decisions=${join(dir, 'decisions.json')}`, `--summary=${join(dir, 'summary.md')}`, `--corrections=${join(dir, 'corrections')}`]);
    const file = yaml.load(readFileSync(join(dir, 'corrections', 'progress.yaml'), 'utf8'));
    assert.deepEqual(file.corrections, [{ id: record.id, report: 1, note: 'Reader report #1: year 1970 → 1971', set: { year: 1971 } }]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'decisions.json'), 'utf8')).map((d) => d.status), ['applied', 'manual', 'manual']);
    const summary = readFileSync(join(dir, 'summary.md'), 'utf8');
    assert.match(summary, /1 corrected, 2 left for manual review/);
    assert.ok(summary.includes('Write to me at [email address removed] or [telephone number removed]'), 'personal details taken out');
    assert.match(summary, /```text\n  Not left @someone <b>\n  ```/, "a reader's text kept as code");
  });
});
