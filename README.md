# Bibliotheca Marxista

An open catalogue of the backlists of Leftist and Marxist publishing houses, defunct and active, from around the world: about 900,000 titles from 600 houses. It also has:
- author pages, the communist internationals and the movements;
- a globe placing every house by country and Cold War alignment;
- a search with facet counts and suggestions;
- each title's other editions, grouped as works;
- citations, statistics and timelines;
- links to the authors' and houses' records in Wikidata, VIAF and the national libraries.

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
| `npm run build:db -- --full` | Rebuilds the database from scratch (~5 min) |
| `npm run api` | Serves the catalogue API from `db/catalogue.sqlite` |
| `npm run preview` / `npm run dev` | Serves the built site / the live development site |
| `npm test` | Runs the tests (also run on GitHub on every push). They cover the database build, the API over HTTP, titles' pages and citations, the works, the review of error reports, the importer's matching rules and screening, the site's filters, and the integrity of the data. |
| `npm run import -- --write` | Imports titles from Open Library and the library catalogues (hours on a first run; see below) |
| `npm run verify-authors -- --write` | Checks the authors' bibliographies against Open Library |
| `node scripts/find-author-variants.mjs --write` | Adds authors' spellings in every script, and their identifiers, from Wikidata |
| `node scripts/link-publishers.mjs --write` | Adds the houses' identifiers from Wikidata |
| `npm run review-reports` | Turns readers' plain error reports into corrections (see [Readers' error reports](#readers-error-reports)) |

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
              search, facets, suggestions, large tables page by page,
              titles' pages, citations, error reports, downloads
```

**The data is plain YAML** in `data/`, the single source of truth. Each publishing house has a file in `data/publishers/`, and its titles are in `data/catalogues/<house>/`. Some are entered by hand, but most are imported, into `openlibrary.yaml`, which each import rewrites; corrections to them are kept apart, in `data/corrections/`, so that they outlast imports. Authors, movements and the internationals each have a folder too. Everything is checked against the schemas in `src/content.config.ts` and `src/lib/schemas.ts` at build time.

**The importer** (`scripts/import-openlibrary.mjs`) gathers editions from Open Library and some twenty library catalogues. It gives each record to a house by matching rules (imprint name, place and years) and writes the catalogue files. See [Importing](#importing).

**The site** is built by [Astro](https://astro.build) into static pages:
- the home page and globe;
- the publisher, author, movement and international pages, each house's and author's with a timeline of their titles by year;
- the Statistics page;
- the plain lists of each house's titles, for readers without JavaScript.

The build also exports every title as JSON for the database.

**The catalogue database** (`scripts/build-db.mjs`) is a SQLite file built from those exports, with full-text search that ignores accents. It also holds:
- the search suggestions (authors, publishers and series);
- the whole catalogue's facet counts;
- the editions grouped as works (`server/works.mjs`): by author and original title, across houses, languages and romanisations.

The build is incremental: it keeps a fingerprint of each publisher's titles, so after an import only the houses that changed are rewritten. That takes seconds, where a full rebuild takes several minutes.

**The catalogue API** (`server/`) is a small Node server over the database, opened read-only:

| Endpoint | Returns |
|---|---|
| `GET /api/titles?q=&pub=&author=&series=&lang=&country=&from=&to=&verified=&free=&sort=&offset=&limit=` | A page of titles, and the total on the first page |
| `GET /api/facets?<the same filters>` | How the titles found divide by language, country, publisher and decade. Counted on a worker thread, a few searches at a time; busy, it answers 503. |
| `GET /api/suggest?q=` | Authors, publishers and series with a word of their name starting so |
| `GET /api/title?p=<publisher>&t=<title id>` | One title's full record |
| `GET /api/cite?p=&t=&format=bibtex\|ris` | A title's citation, as a file for citation managers |
| `POST /api/report` | A reader's report of an error in a title (see [Readers' error reports](#readers-error-reports)) |
| `GET /api/export[?pub=<publisher>]` | The whole catalogue, or one house's backlist, as a JSON download, generated as it streams |
| `GET /api/health` | The number of titles and when the database was built |
| `GET /book/<publisher>/<title>` | A title's page as HTML, for readers and search engines. It shows the record, the work's other editions, the citations and the error form, and carries schema.org data and Google Scholar tags. |
| `GET /sitemap-books-<n>.xml` | Sitemaps of every title's page, 50,000 to each |

**In the browser**, pages show their first titles straight from the HTML.
- **The Titles page's search** fetches from the API, with facet counts to narrow it and suggestions of authors, publishers and series as the reader types.
- **The large tables** (any table of more than 300 titles: a big house's backlist, a prolific author's editions) fetch from the API too, a page at a time. Each title's page is rendered by the API as plain HTML, so that search engines can index it. Smaller tables filter and sort in the page without it.

## Project structure

```
data/
  publishers/<id>.yaml          a publishing house: names, place, years, status, history, sources
  catalogues/<id>/*.yaml        its titles: openlibrary.yaml (imported) and any hand-written files
  authors/<id>.yaml             an author: biography, name spellings, first-edition bibliography
  movements/<id>.yaml           a party or liberation movement and its works
  internationals/<id>.yaml      a communist international, its presses and works
  series/<id>.yaml              a publisher's series (e.g. International Publishers' New World Paperbacks)
  corrections/<id>.yaml         corrections to a house's titles, kept apart from the imported files

src/
  content.config.ts             schemas of publishers, authors, movements and internationals
  lib/schemas.ts                schemas of the catalogue and correction files, and of identifiers
  lib/catalogue.ts              loading the data: title ids and links, author matching, dates, copyright
  lib/corrections.ts            applying data/corrections/ to the titles
  lib/name-key.mjs              how names are compared (shared with the scripts)
  lib/globe.ts, globe-places.ts countries, regions and pins of the globe; where each house is placed
  lib/api.ts                    the browser's side of the catalogue API
  lib/filters.ts, rows-shared.ts  table filters, sorting and the compact row format
  components/                   CatalogueTable (paged and in-page tables), Globe, Timeline, BarTable, …
  pages/                        the site's pages; pages/data/ holds the build's exports
  data/                         map overlays: divided Germany, the 1947 partition of Palestine

scripts/
  import-openlibrary.mjs        the importer: matching rules (PUBLISHERS) and catalogue searches
  lib/sources.mjs               fetchers of each library catalogue (cached in .cache/sources)
  lib/marxist-houses.mjs        table of the Marxist and socialist-state houses added in batches
  lib/not-left.mjs              screening: fascist, conservative and liberal authors kept out
  lib/free-access.mjs           free copies: Internet Archive, HathiTrust, Gutenberg, NDL, Gallica
  lib/publisher-names.mjs       normalising publisher names
  lib/wikidata.mjs              Wikidata: a house's item, and the identifiers the site links to
  build-db.mjs                  the catalogue database
  verify-authors.mjs            checks authors' bibliographies; find-author-*.mjs find name spellings
                                (find-author-variants.mjs: in every script, from Wikidata, with the authors' identifiers)
  link-publishers.mjs           the houses' identifiers (Wikidata, VIAF, the Library of Congress, GND, ISNI, BnF)
  merge-people.mjs              carries an import's translators, editors and original titles into the committed files
  check-publisher-years.mjs     fills in houses' years of activity from Wikidata or the catalogue
  import-internationals.mjs     the internationals' works
  review-reports.mjs            turns readers' plain error reports into corrections (rules: lib/report-review.mjs)

server/
  server.mjs                    the catalogue API
  query.mjs                     building and checking its search queries
  book.mjs, cite.mjs            titles' pages, their linked data and citations
  works.mjs                     editions grouped as works
  facets-worker.mjs             facet counts, on their own thread
  reports.mjs, reports-cli.mjs  readers' error reports, and the maintainers' tool for them
  reports-ssh.sh                the one command the report-review workflow may run on the server
  Dockerfile, Caddyfile.example deployment

test/                           tests (npm test): database, API, importer rules, site logic, data integrity
.github/workflows/              CI (the tests, on every push) and the weekly review of readers' reports
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
identifiers:             # optional; filled in by scripts/link-publishers.mjs
  wikidata: "Q…"         # also viaf, lcnaf, gnd, isni, bnf
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

A title's page is `/book/<publisher>/<id>`, where the id comes from its title and year (`the-road-to-wigan-pier-1937`). Set an explicit `id` if a title's link must stay the same after its title or year is corrected.

**A correction** to a title, imported or not: `data/corrections/<publisher>.yaml`. The title is named by its id, which stays its address whatever the correction changes, and the correction outlasts re-imports.

```yaml
publisher: progress-publishers
corrections:
  - id: the-state-and-revolution-1970
    note: Year from the colophon
    set: { year: 1971, translators: [Clemens Dutt] }   # any of the title's fields
  - id: the-state-and-revolution-1970-2
    remove: true                                      # a duplicate
```

The build warns of a correction whose title an import has renamed or dropped.

**An author**: `data/authors/<id>.yaml` holds a biography and a first-edition bibliography (`works`). Each work names its publisher as printed, and optionally `publisher_id` when that house is in the catalogue. An author's page also lists every catalogued edition credited to them under any of their `alternate_names`, as author, editor or translator. `scripts/find-author-variants.mjs` adds the spellings the catalogue credits in other scripts and romanisations, and the author's `identifiers`, from Wikidata. It adds a spelling only when one author alone claims it, and leaves out initials that could be anyone's.

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
- **Dates.** When a library record's imprint gives a year still to come but its coded date (MARC 008) does not, the coded date is used. A title announced by its publisher for a later year is kept, and shown as forthcoming.
- **Review.** Rejected and unresolved records are listed in `reports/import-review.md`.
- **People.** Library records give each person a role: authors, translators and editors are kept apart, and the original title of a translation is read (MARC 240, 765 and 500; UNIMARC 454 and 500). An import run from the cache alone may miss records whose responses were not cached; then `node scripts/merge-people.mjs --write` carries only those fields into the committed files.
- **Run time and memory.** A full run reads about a million records. Run it with `node --max-old-space-size=10240 scripts/import-openlibrary.mjs --write`. Later runs read the catalogues from the cache and take about 1–2 hours.

## Deploying

The whole site runs on one small server (any host with Docker, such as a €5/month VPS), behind a CDN such as Cloudflare:

- **Caddy** serves the static pages in `dist/` (about 8,200 files, 320 MB). It passes `/api/*`, each title's page (`/book/<publisher>/<title>`) and the titles' sitemaps (`/sitemap-books-<n>.xml`) to the API.
- **The catalogue API** (`server/`) serves those from its database `db/catalogue.sqlite` (about 1.7 GB).

The titles' pages are on the site's own address so that search engines credit them to it. The sitemap index, `/sitemap.xml`, lists the site's pages and every title.

**First deployment**

1. Set `site` in `astro.config.mjs` to the site's address, and build: `npm run build`.
2. On the server, install Docker and Caddy, and copy the site and the database to it:
   ```sh
   rsync -a --delete dist/ server:/srv/bibliotheca/dist/
   rsync db/catalogue.sqlite server:/srv/bibliotheca/db/catalogue.sqlite
   ```
3. Run the API, with the site's address for its canonical links and sitemaps:
   ```sh
   docker build -f server/Dockerfile -t bibliotheca-api .
   docker run -d --name bibliotheca-api --restart unless-stopped \
     -p 127.0.0.1:8787:8787 -v /srv/bibliotheca/db:/app/db:ro -v /srv/bibliotheca/var:/app/var \
     --read-only --cap-drop ALL --security-opt no-new-privileges --memory 1g --cpus 1 --pids-limit 100 \
     -e SITE_URL=https://bibliothecamarxista.org -e SITE_ORIGIN=https://bibliothecamarxista.org -e TRUST_PROXY=1 bibliotheca-api
   ```
4. Configure Caddy from `server/Caddyfile.example`, with the site's domain. It imports the security headers the build writes (`dist/headers.caddy`), shows the site's 404 page for addresses that don't exist, and shows a "briefly unavailable" page while the API is down.
5. Point the domain at Cloudflare (or another CDN), and the CDN at the server. Submit `https://<domain>/sitemap.xml` to Google Search Console and Bing Webmaster Tools.

**Updating after an import**

```sh
npm run import -- --write
npm run build
rsync -a --delete dist/ server:/srv/bibliotheca/dist/
rsync db/catalogue.sqlite server:/srv/bibliotheca/db/catalogue.sqlite
```

`rsync` sends only the files, and the parts of the database, that changed. It moves the new database into place in one step, and the API opens it within a minute.

The API:
- limits each address's rate of requests;
- serves at most two downloads at once;
- counts facets on a worker thread, a few searches at a time;
- marks searches cacheable for an hour and titles' pages for a day, so the CDN absorbs repeated requests.

## Readers' error reports

Every title's page has a "Report an error" form. Reports are stored on the server (`var/reports.sqlite`, apart from the catalogue) and reviewed by `scripts/review-reports.mjs`:

- **Corrected:** a report whose correction is plain becomes a correction in `data/corrections/`. Examples are a single year, a quoted title or author, one language, a named broken link, or a duplicate's address.
- **Manual:** any other report is left for a maintainer, with the reason. That covers anything unsure, vague or long, a correction that shares no word with the record, a link to another site, and every report about the publisher or the scope.

The rules are in `scripts/lib/report-review.mjs`. Corrections are reviewed before they are merged, since reports are anonymous.

The pull request quotes what readers wrote, with email addresses and telephone numbers taken out, and the form tells readers their words may be published.

**Automatically:** the "Review readers' reports" workflow runs every Monday, and can also be started by hand. It fetches the open reports over SSH, opens a pull request with the corrections and the reports' text, and records each report's outcome on the server. It needs the secrets listed at the top of `.github/workflows/review-reports.yml`, and a key limited to `server/reports-ssh.sh`. That user runs `docker exec`, which amounts to root on the server, so keep the key to that one command.

**By hand:**

```sh
docker exec bibliotheca-api node server/reports-cli.mjs export > open.json
npm run review-reports -- --from=open.json --decisions=decisions.json   # writes data/corrections/, reports/report-review.md
docker exec -i bibliotheca-api node server/reports-cli.mjs import < decisions.json
docker exec bibliotheca-api node server/reports-cli.mjs                 # the reports left for manual review
```

## Licence

Bibliotheca Marxista is free to use, copy and build on, under three licences:

| Part | Licence | File |
|---|---|---|
| The code: `src/`, `scripts/`, `server/`, `test/` | [GNU Affero General Public License 3.0](https://www.gnu.org/licenses/agpl-3.0.html) or later | [`LICENSE`](LICENSE) |
| The catalogue's data: `data/`, the database and the downloads | [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/) | [`LICENSE-DATA.txt`](LICENSE-DATA.txt) |
| The texts: the histories of the houses, the authors' biographies and the site's pages | [Creative Commons Attribution-ShareAlike 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | [`LICENSE-TEXT.txt`](LICENSE-TEXT.txt) |

In short:
- **The data:** reuse it with credit to Bibliotheca Marxista, and share a database made from it under the ODbL.
- **The texts:** reuse them with credit, and share adaptations alike.
- **The code:** a modified version run as a public site must publish its source.

The downloads carry these terms in their `license` field.

**Sources.** The catalogue is built from other catalogues' records, all reusable in an ODbL database; those that ask for credit are credited on the About page and in the downloads.

| Source | Terms of its records | Credit |
|---|---|---|
| Open Library, Wikidata, the Library of Congress, the German National Library, K10plus, B3Kat, the Biblioteca Nacional de España, the National Library of Poland | Public domain or CC0 | Not required |
| The Bibliothèque nationale de France, ABES (SUDOC) | France's [Licence Ouverte](https://www.etalab.gouv.fr/licence-ouverte-open-licence/) | Required |
| CiNii Books (National Institute of Informatics) | NACSIS-CAT records are open data under [CC BY 4.0](https://support.nii.ac.jp/en/cinii/api/api_outline) | Required |
| The National Diet Library | Its catalogue's data may be reused, commercially too, under [terms compatible with CC BY 4.0](https://ndl.go.jp/en/use/metadata/index.html); only the NDL's own catalogue is searched, not NDL Search's other providers | Required |
| swisscovery (SLSP) | Unmarked bibliographic metadata is ["free for general use"](https://slsp.ch/en/?p=1277) | Not required |
| HathiTrust | Its own work on the records is [CC0](https://www.hathitrust.org/the-collection/terms-conditions/metadata-sharing-and-use-policy/); records it holds may be harvested and used freely, and some derive from OCLC's WorldCat | WorldCat credited, as OCLC asks of reusers |

Scans and texts held elsewhere (the Internet Archive, HathiTrust, marxists.org, BannedThought.net) are linked, not copied, and remain under their own terms.

## Security

The site's pages are static files, and its only server is the catalogue API, which only reads (its database is opened read-only, and mounted read-only in its container). Neither has accounts, cookies, secrets or tracking, and client addresses are held only in memory, to limit request rates.

**Built in**

- **No SQL injection.** The API binds every value as a parameter and accepts only listed sorts and filters (`server/query.mjs`). A search becomes plain words before it reaches the full-text index.
- **No HTML injection from the data.** Imported records come partly from editable sources such as Open Library, so:
  - pages render text, never markup;
  - rows drawn from the API escape every value;
  - links must be `http` or `https` (the schema rejects `javascript:` and `data:`).
- **Security headers.**
  - The site sends a Content Security Policy from `dist/_headers`, written by `scripts/write-headers.mjs`. It allows scripts, styles and media from the site alone, requests to the API alone, and no framing. The build fails if a page has inline code the policy would block.
  - The API sends `nosniff` and a deny-all policy with every response.
- **Abuse limits.**
  - Each client address may make a burst of 120 requests, then 2 a second; a download costs 30.
  - At most two downloads stream at once, and whole-catalogue downloads (about 600 MB each) are capped at `EXPORT_HOURLY_LIMIT` an hour across all clients.
  - Recent answers are cached in memory, so a repeated expensive query does not reach the database.
  - Facet counts, which take seconds over a broad search, run on their own thread, a few at a time. Beyond that the API answers 503, so a stream of them cannot hold up other requests.
  - Readers' error reports are capped at 5 an hour from an address and 500 a day in all, and a hidden field turns away bots.
- **Forged addresses.** Behind Caddy, the API takes the client's address from `X-Real-IP`. Caddy sets that header itself, replacing whatever a client sends, so it can't be faked to escape the limits; `X-Forwarded-For` is never trusted. With Cloudflare in front, set `trusted_proxies` as in `server/Caddyfile.example`, or every visitor would share Cloudflare's addresses.
- **Least privilege.** The container runs as an unprivileged user, on a read-only filesystem, with no Linux capabilities and with limits on memory, CPU and processes.

**When deploying**

1. On the API host:
   - open only ports 22, 80 and 443;
   - allow SSH by key only;
   - turn on automatic security updates (`unattended-upgrades`);
   - bind the API to `127.0.0.1`, as above, so that it is reached only through Caddy.
2. Put Cloudflare, or another CDN, in front of the API as well as the site. It absorbs floods, and caches API answers (they are marked cacheable for an hour).
3. On GitHub, where the tests already run on every push (`.github/workflows/ci.yml`, with its actions pinned to commits), turn on:
   - Dependabot alerts and secret scanning;
   - branch protection on `main`, requiring the CI check;
   - for the report-review workflow, "Allow GitHub Actions to create and approve pull requests", and its secrets.
4. Check `npm audit` before each deployment.
5. Review contributed data like code. The schema rejects unsafe links, but not wrong or misleading ones.
6. If Caddy's access logs are turned on, they hold visitors' addresses: keep them briefly, and say so in a privacy note.

To report a security problem, contact the maintainers privately rather than opening a public issue.
