// A small catalogue for the tests: a few titles exported as `astro build` exports them, built into a
// database by scripts/build-db.mjs, as in a real build.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const ROOT = join(new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));

export const record = (id, title, extra = {}) => ({
  id, title, authors: [], editors: [], translators: [], date: String(extra.year ?? 'n.d.'), places: [], language: 'English',
  links: [], sources: [], verified: false, copyright: [], ...extra,
});

export const PUBLISHERS = {
  progress: { name: 'Progress Publishers', city: 'Moscow', country: 'Soviet Union', titles: [
    record('state-and-revolution-1970', 'The State and Revolution', { year: 1970, authors: [{ name: 'V. I. Lenin', href: '/authors/lenin' }], places: ['Soviet Union'], verified: true }),
    record('capital-1965', 'Capital', { year: 1965, series: 'Little Marx Library -- v. 3', authors: [{ name: 'Karl Marx', href: '/authors/marx' }], links: [{ label: 'Scan (Internet Archive)', url: 'https://archive.org/details/x' }] }),
    record('chudozestvennaja-1975', 'Chudožestvennaja literatura i žizn', { year: 1975, language: 'Russian', places: ['Soviet Union'] }),
  ] },
  'international-publishers': { name: 'International Publishers', city: 'New York', country: 'United States', titles: [
    record('wage-labour-1933', 'Wage-Labour and Capital', { year: 1933, series: 'Little Marx Library; 5', authors: [{ name: 'Karl Marx', href: '/authors/marx' }], places: ['United States'] }),
    record('undated', 'An Undated Pamphlet'),
  ] },
};
export const AUTHOR_TITLES = { marx: ['/book/progress/capital-1965', '/book/international-publishers/wage-labour-1933'] };
export const AUTHORS = [{ id: 'marx', name: 'Karl Marx' }, { id: 'lenin', name: 'V. I. Lenin' }];

export const TEMPLATE = `<!doctype html><html lang="en"><head><meta name="description" content="A catalogued title."><meta name="robots" content="noindex, follow"><link rel="canonical" href="https://example.org/title/"><meta property="og:type" content="website"><meta property="og:title" content="Title"><meta property="og:description" content="A catalogued title."><meta property="og:url" content="https://example.org/title/"><meta name="twitter:title" content="Title"><meta name="twitter:description" content="A catalogued title."><title>Title · Bibliotheca Marxista</title></head><body><main><div class="title-record" data-astro-cid-x><p class="meta" data-status>Loading…</p></div></main><footer>footer</footer></body></html>`;

/** A temporary folder with exports (dist/) and a database built from them; `export` rewrites the exports. */
export function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'catalogue-'));
  const dist = join(dir, 'dist');
  const dbFile = join(dir, 'catalogue.sqlite');
  const exportCatalogue = (pubs = PUBLISHERS, authorTitles = AUTHOR_TITLES) => {
    rmSync(dist, { recursive: true, force: true });
    mkdirSync(join(dist, 'data', 'db'), { recursive: true });
    const list = Object.entries(pubs).map(([id, p]) => ({ id, name: p.name, city: p.city, country: p.country, titles: p.titles.length, chunks: 1 }));
    writeFileSync(join(dist, 'data', 'catalogue.json'), JSON.stringify({ publishers: list }));
    for (const [id, p] of Object.entries(pubs)) {
      mkdirSync(join(dist, 'data', 'titles', id), { recursive: true });
      writeFileSync(join(dist, 'data', 'titles', id, '0.json'), JSON.stringify(p.titles));
    }
    writeFileSync(join(dist, 'data', 'db', 'author-titles.json'), JSON.stringify(authorTitles));
    writeFileSync(join(dist, 'data', 'db', 'authors.json'), JSON.stringify(AUTHORS));
    // The site's title page, which the API fills in for each title (as dist/title/index.html).
    mkdirSync(join(dist, 'title'), { recursive: true });
    writeFileSync(join(dist, 'title', 'index.html'), TEMPLATE);
  };
  const build = () =>
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-db.mjs'), '--keep'], {
      env: { ...process.env, CATALOGUE_DIST: dist, CATALOGUE_DB: dbFile }, encoding: 'utf8',
    });
  exportCatalogue();
  build();
  return { dir, dist, dbFile, exportCatalogue, build, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
