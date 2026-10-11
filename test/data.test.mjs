// The catalogue's data (data/*.yaml) holds together, checked without a build: every house can be
// placed on the globe, links between files lead somewhere, years make sense, and no two author
// pages claim the same name (their editions would go to the wrong page).
import assert from 'node:assert/strict';
import { openSync, readFileSync, readSync, closeSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import * as yaml from 'js-yaml';
import { COUNTRIES, REGIONS } from '../src/lib/globe.ts';
import { ROOT } from './fixture.mjs';

const load = (dir) =>
  readdirSync(join(ROOT, 'data', dir)).filter((f) => f.endsWith('.yaml')).map((f) => ({ id: f.slice(0, -5), ...yaml.load(readFileSync(join(ROOT, 'data', dir, f), 'utf8')) }));
const publishers = load('publishers');
const ids = new Set(publishers.map((p) => p.id));
const internationals = new Set(load('internationals').map((i) => i.id));
const authors = load('authors');
const problems = (list) => assert.deepEqual(list, [], `\n  ${list.join('\n  ')}`);

describe('publishers', () => {
  test('can each be placed on the globe', () => {
    problems(publishers.filter((p) => !p.international).flatMap((p) => {
      if (!COUNTRIES[p.country]) return [`${p.id}: no globe country "${p.country}"`];
      if (p.region && REGIONS[p.region]?.country !== p.country) return [`${p.id}: region "${p.region}" is not one of ${p.country}`];
      return [];
    }));
  });

  test('link only to publishers and internationals on file', () => {
    problems(publishers.flatMap((p) => [
      ...['predecessor', 'successor', 'parent'].filter((k) => p[k] && !ids.has(p[k])).map((k) => `${p.id}: ${k} "${p[k]}" is not on file`),
      ...(p.international && !internationals.has(p.international) ? [`${p.id}: international "${p.international}" is not on file`] : []),
    ]));
  });

  test('have years that make sense', () => {
    problems(publishers.flatMap((p) => [
      ...(p.founded && p.dissolved && p.founded > p.dissolved ? [`${p.id}: founded ${p.founded} after its closing in ${p.dissolved}`] : []),
      ...(p.dissolved && p.status === 'active' ? [`${p.id}: active, yet closed in ${p.dissolved}`] : []),
      ...(p.estimated ?? []).filter((k) => p[k] == null).map((k) => `${p.id}: "${k}" marked estimated but not given`),
      ...['founded', 'dissolved'].filter((k) => p[k] != null && (p[k] < 1700 || p[k] > new Date().getFullYear())).map((k) => `${p.id}: ${k} ${p[k]}`),
    ]));
  });
});

describe('catalogue files', () => {
  // Only the start of each file is read: the catalogue runs to hundreds of megabytes.
  const head = (file) => {
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, 4096, 0);
    closeSync(fd);
    return buf.subarray(0, n).toString('utf8');
  };
  test('each belong to a publisher on file, in that publisher\'s folder', () => {
    const dir = join(ROOT, 'data', 'catalogues');
    problems(readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.yaml')).flatMap((f) => {
      const publisher = /^publisher:\s*(\S+)/m.exec(head(join(dir, f)))?.[1];
      const folder = f.split(/[\\/]/)[0].replace(/\.yaml$/, '');
      if (!ids.has(publisher)) return [`${f}: publisher "${publisher}" is not on file`];
      return publisher === folder ? [] : [`${f}: names ${publisher}, but is filed under ${folder}`];
    }));
  });
});

describe('authors', () => {
  test('have years that make sense', () => {
    problems(authors.flatMap((a) => [
      ...(a.born && a.died && a.born > a.died ? [`${a.id}: born ${a.born} after dying in ${a.died}`] : []),
      ...(a.works ?? []).filter((w) => !Number.isInteger(w.year)).map((w) => `${a.id}: "${w.title}" has no year`),
      ...(a.works ?? []).filter((w) => w.publisher_id && !ids.has(w.publisher_id)).map((w) => `${a.id}: "${w.title}" names publisher "${w.publisher_id}", not on file`),
    ]));
  });

  test('do not share a name with another author page', () => {
    const plain = (s) => String(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const owner = new Map();
    const clashes = [];
    for (const a of authors) {
      for (const n of new Set([a.name, ...(a.alternate_names ?? [])].map(plain))) {
        if (owner.has(n) && owner.get(n) !== a.id) clashes.push(`"${n}": ${owner.get(n)} and ${a.id}`);
        else owner.set(n, a.id);
      }
    }
    problems(clashes);
  });
});
