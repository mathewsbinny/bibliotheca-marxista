# Bibliotheca Marxista

An open catalogue of the backlists of Leftist and Marxist publishing houses, defunct and active, from around the world: about 900,000 titles from 600 houses, with author pages, the communist internationals and the movements, and a globe placing every house by country and Cold War alignment.

## Quick start

Requirements: Node.js 22 or later, and about 10 GB of free memory for builds.

```sh
npm install
npm run build      # the static site (dist/) and the catalogue database (db/catalogue.sqlite); ~5 min
npm run api        # terminal 1: the catalogue API on http://localhost:8787
npm run preview    # terminal 2: the site on http://localhost:4321, with /api passed to the API
```

Open <http://localhost:4321>. To work on the site's code, run `npm run dev` instead of `npm run preview`: it reloads on every change (the first page each time takes about a minute, as it reads the whole catalogue).

| Command | What it does |
|---|---|
| `npm run build` | Builds the pages, then updates the catalogue database: only publishers whose titles changed are rewritten |
| `npm run build:db -- --full` | Rebuilds the database from scratch (~2 min) |
| `npm run api` | Serves the catalogue API from `db/catalogue.sqlite` |
| `npm run preview` / `npm run dev` | Serves the built site / the live development site |
| `npm test` | Tests the database build and the API's queries |
| `npm run import -- --write` | Imports titles from Open Library and the library catalogues (hours on a first run; see below) |
| `npm run verify-authors -- --write` | Checks the authors' bibliographies against Open Library |

## How it works

```
data/*.yaml ──► npm run import ──► data/catalogues/<house>/openlibrary.yaml
   (the catalogue, by hand and imported)

data/*.yaml ──► astro build ──► dist/                  static pages: home, publishers, authors, …
                    │
                    └──► dist/data/titles, dist/data/db   title exports (build input only)
                              │
                              └──► scripts/build-db.mjs ──► db/catalogue.sqlite

browser ──► static pages (dist/)
        └─► /api/* ──► server/server.mjs ──► db/catalogue.sqlite
              search, large tables page by page, title records, downloads
```

**The data is plain YAML** in `data/`, the single source of truth. Each publishing house has a file in `data/publishers/`, and its titles are in `data/catalogues/<house>/`. Some are entered by hand, but most are imported, into `openlibrary.yaml`, which each import rewrites. Authors, movements and the internationals each have a folder too. Everything is checked against the schemas in `src/content.config.ts` and `src/lib/schemas.ts` at build time.

**The importer** (`scripts/import-openlibrary.mjs`) gathers editions from Open Library and some twenty library catalogues. It gives each record to a house by matching rules (imprint name, place and years) and writes the catalogue files. See [Importing](#importing).

**The site** is built by [Astro](https://astro.build) into static pages: the home page and globe, the publisher, author, movement and international pages, and the plain lists of each house's titles for readers without JavaScript. The build also exports every title as JSON for the database.

**The catalogue database** (`scripts/build-db.mjs`) is a SQLite file built from those exports, with full-text search that ignores accents. The build is incremental: it keeps a fingerprint of each publisher's titles, so after an import only the houses that changed are rewritten. Seconds, where a full rebuild takes about two minutes.

**The catalogue API** (`server/`) is a small Node server over the database, opened read-only:

| Endpoint | Returns |
|---|---|
| `GET /api/titles?q=&pub=&author=&lang=&country=&from=&to=&verified=&free=&sort=&offset=&limit=` | A page of titles, and the total on the first page |
| `GET /api/title?p=<publisher>&t=<title id>` | One title's full record |
| `GET /api/export[?pub=<publisher>]` | The whole catalogue, or one house's backlist, as a JSON download, generated as it streams |
| `GET /api/health` | The number of titles and when the database was built |

**In the browser**, pages show their first titles straight from the HTML. The Titles page's search, the large tables (any table of more than 300 titles: a big house's backlist, a prolific author's editions) and the title pages fetch from the API, a page at a time. Smaller tables filter and sort in the page without it.

## Project structure

```
data/
  publishers/<id>.yaml          a publishing house: names, place, years, status, history, sources
  catalogues/<id>/*.yaml        its titles: openlibrary.yaml (imported) and any hand-written files
  authors/<id>.yaml             an author: biography, name spellings, first-edition bibliography
  movements/<id>.yaml           a party or liberation movement and its works
  internationals/<id>.yaml      a communist international, its presses and works
  series/<id>.yaml              a publisher's series (e.g. International Publishers' New World Paperbacks)

src/
  content.config.ts             schemas of publishers, authors, movements and internationals
  lib/schemas.ts                schema of the catalogue files (read directly, not by Astro's content layer)
  lib/catalogue.ts              loading the data: title ids and links, author matching, dates, copyright
  lib/globe.ts, globe-places.ts countries, regions and pins of the globe; where each house is placed
  lib/api.ts                    the browser's side of the catalogue API
  lib/filters.ts, rows-shared.ts  table filters, sorting and the compact row format
  components/                   CatalogueTable (paged and in-page tables), Globe, WorksTable, …
  pages/                        the site's pages; pages/data/ holds the build's exports
  data/                         map overlays: divided Germany, the 1947 partition of Palestine

scripts/
  import-openlibrary.mjs        the importer: matching rules (PUBLISHERS) and catalogue searches
  lib/sources.mjs               fetchers of each library catalogue (cached in .cache/sources)
  lib/marxist-houses.mjs        table of the Marxist and socialist-state houses added in batches
  lib/not-left.mjs              screening: fascist, conservative and liberal authors kept out
  lib/free-access.mjs           free copies: Internet Archive, HathiTrust, Gutenberg, NDL, Gallica
  lib/publisher-names.mjs       normalising publisher names
  build-db.mjs                  the catalogue database
  verify-authors.mjs            checks authors' bibliographies; find-author-*.mjs find name spellings
  check-publisher-years.mjs     fills in houses' years of activity from Wikidata or the catalogue
  import-internationals.mjs     the internationals' works

server/
  server.mjs                    the catalogue API
  query.mjs                     building and checking its search queries
  Dockerfile, Caddyfile.example deployment

test/                           tests of the database and API (npm test)
.cache/                         downloaded records (kept between runs; not in the repository)
db/                             the catalogue database (built; not in the repository)
reports/                        logs and review reports of imports and checks
```

## Adding data

**A publisher**: `data/publishers/left-book-club.yaml`

```yaml
name: Left Book Club
country: United Kingdom
city: London
founded: 1936
dissolved: 1948          # omit for active houses
status: defunct          # or: active
estimated: [dissolved]   # optional: years inferred from the catalogue, shown as "c. 1948"
region: …                # optional: a region with its own pin (a Soviet or Yugoslav republic, Puerto Rico; see REGIONS in src/lib/globe.ts)
successor: some-id       # optional links to other publisher files
description: >
  A short history.
sources:
  - title: A bibliographic source
    url: https://…
```

**Titles**: `data/catalogues/left-book-club/hand.yaml` (any file name except `openlibrary.yaml`, which imports overwrite)

```yaml
publisher: left-book-club
titles:
  - title: The Road to Wigan Pier
    authors: [George Orwell]
    year: 1937
    language: English
    series: …              # optional: subtitle, original_title, editors, translators,
    notes: …               # date_note, edition, pages, isbn, links, sources, id
    verified: true         # only once checked against a source
```

A title's page is `/title/?p=<publisher>&t=<id>`, where the id comes from its title and year (`the-road-to-wigan-pier-1937`). Set an explicit `id` if a title's link must stay the same after its title or year is corrected.

**An author**: `data/authors/<id>.yaml` holds a biography and a first-edition bibliography (`works`). Each work names its publisher as printed, and optionally `publisher_id` when that house is in the catalogue. An author's page also lists every catalogued edition credited to them under any of their `alternate_names`, as author, editor or translator.

## Importing

```sh
npm run import                 # dry run: fetch, match, write reports/import-review.md
npm run import -- --write      # write data/catalogues/<id>/openlibrary.yaml
npm run build                  # then rebuild the site and update the database
```

- **Sources.** The importer gathers editions from these sources, all cached in `.cache/`:
  - **Open Library**;
  - **library catalogues:** the Library of Congress, the German National Library, the BnF, SUDOC, swisscovery, the National Library of Poland, the National Diet Library, CiNii, K10plus, B3Kat, Spain's BNE and HathiTrust (from its monthly Hathifiles, downloaded to `.cache/hathifiles/`);
  - **scans:** the Internet Archive and BannedThought.net.
- **Matching.** A record is given to a house by its imprint's name **and** its place (or MARC country code), within the house's years. This is what separates, say, the Moscow, Hanoi, Pyongyang and Beijing foreign-languages presses. The rules are `PUBLISHERS` in `scripts/import-openlibrary.mjs`, plus the table in `scripts/lib/marxist-houses.mjs`. Romanisations are matched in their variant forms: Library of Congress, ISO 9, DIN 1460 and pinyin.
- **Verified titles.** A title is `verified: true` only if a library catalogue record of it names the house and a matching place.
- **Screening.** Authors in `scripts/lib/not-left.mjs` are kept out. For authors who moved right, only their works from their left years are kept (`LEFT_UNTIL`).
- **Review.** Rejected and unresolved records are listed in `reports/import-review.md`.
- **Run time and memory.** A full run reads about a million records. Run it with `node --max-old-space-size=10240 scripts/import-openlibrary.mjs --write`. Later runs read the catalogues from the cache and take about 1–2 hours.

## Deploying

The site has two parts:

- the **static pages** in `dist/` (about 8,000 files, 300 MB), for a static host such as Cloudflare Pages;
- the **catalogue API** (`server/`) with its database `db/catalogue.sqlite` (about 1.5 GB), on a small server: any host that runs Docker or Node 22, such as a €5/month VPS.

**First deployment**

1. Set `site` in `astro.config.mjs` to the site's URL.
2. On the API host, install Docker and Caddy, then run the API and configure Caddy from `server/Caddyfile.example`:
   ```sh
   docker build -f server/Dockerfile -t bibliotheca-api .
   docker run -d --restart unless-stopped -p 127.0.0.1:8787:8787 -v /srv/bibliotheca/db:/app/db \
     -e SITE_ORIGIN=https://bibliotheca-marxista.org -e TRUST_PROXY=1 bibliotheca-api
   ```
3. Build the site with the API's address and upload it (leave `PUBLIC_API_URL` unset if the API is served from the site's own domain under `/api`):
   ```sh
   PUBLIC_API_URL=https://api.bibliotheca-marxista.org/api npm run build
   npx wrangler pages deploy dist --project-name bibliotheca-marxista
   ```

**Updating after an import**

```sh
npm run import -- --write
PUBLIC_API_URL=https://api.bibliotheca-marxista.org/api npm run build
npx wrangler pages deploy dist --project-name bibliotheca-marxista     # uploads only changed files
rsync db/catalogue.sqlite api-host:/srv/bibliotheca/db/catalogue.sqlite
```

`rsync` sends only the parts of the database that changed and moves the new file into place in one step; the API opens it within a minute. The API limits each address's rate of requests, serves at most two downloads at once, and marks responses cacheable for an hour, so a CDN in front of it absorbs repeated searches.
