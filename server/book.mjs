/**
 * A title's page as HTML, rendered by the catalogue API so that search engines can index every
 * title (/book/<publisher>/<title>). The page is the site's own title page (dist/title/index.html,
 * stored in the database as a template by scripts/build-db.mjs) with the record written into it:
 * its header, footer and styles are the site's, and its head carries the title's description,
 * canonical address and schema.org Book data.
 */

import { citationMeta, references } from './cite.mjs';
import { KINDS, MAX_MESSAGE } from './reports.mjs';

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** JSON safe inside a <script> element: no "</script>", no HTML comment openers. */
const safeJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

const names = (list) => (list.length <= 2 ? list.join(' & ') : `${list.slice(0, -1).join(', ')} & ${list.at(-1)}`);
const link = (href, text) => `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;
const searchLink = (text) => link(`/titles?q=${encodeURIComponent(text)}`, text);
/** Only web addresses are linked; the schema admits nothing else, but the page does not rely on it. */
const isWeb = (url) => /^https?:\/\//i.test(String(url ?? ''));

// The languages' codes (BCP 47), so that a screen reader reads a title in its own language.
export const LANG_CODES = {
  Russian: 'ru', German: 'de', French: 'fr', Spanish: 'es', Italian: 'it', Portuguese: 'pt', Chinese: 'zh', Japanese: 'ja',
  Korean: 'ko', Vietnamese: 'vi', Polish: 'pl', Czech: 'cs', Slovak: 'sk', Hungarian: 'hu', Bulgarian: 'bg', Romanian: 'ro',
  Serbian: 'sr', Croatian: 'hr', 'Serbo-Croatian': 'sh', Slovenian: 'sl', Macedonian: 'mk', Albanian: 'sq', Greek: 'el',
  Turkish: 'tr', Arabic: 'ar', Persian: 'fa', Hebrew: 'he', Yiddish: 'yi', Hindi: 'hi', Bengali: 'bn', Urdu: 'ur', Tamil: 'ta',
  Malayalam: 'ml', Swedish: 'sv', Norwegian: 'no', Danish: 'da', Finnish: 'fi', Icelandic: 'is', Dutch: 'nl', Ukrainian: 'uk',
  Belarusian: 'be', Estonian: 'et', Latvian: 'lv', Lithuanian: 'lt', Georgian: 'ka', Armenian: 'hy', Azerbaijani: 'az',
  Kazakh: 'kk', Uzbek: 'uz', Mongolian: 'mn', Lao: 'lo', Khmer: 'km', Indonesian: 'id', Tagalog: 'tl', Catalan: 'ca', Basque: 'eu',
  Latin: 'la', Esperanto: 'eo', Amharic: 'am', Swahili: 'sw',
};
/** A lang attribute for a title in a language other than English ("Russian, English": its first). */
const langAttr = (language) => {
  const code = LANG_CODES[String(language ?? '').split(', ')[0]];
  return code ? ` lang="${code}"` : '';
};

/** The record as the page's body: as src/pages/title.astro rendered it in the browser before. */
export function bookBody(r, publisherId, publisher) {
  const imprint = `${publisher.place}: ${publisher.name}, ${r.date}`;
  const rows = [];
  if (r.authors.length) {
    rows.push([`Author${r.authors.length > 1 ? 's' : ''}`,
      r.authors.map((a) => link(a.href ?? `/titles?q=${encodeURIComponent(a.name)}`, a.name)).join(', ')]);
  }
  if (r.editors?.length) rows.push(['Edited by', escapeHtml(names(r.editors))]);
  if (r.translators?.length) rows.push(['Translated by', escapeHtml(names(r.translators))]);
  if (r.original_title) rows.push(['Original title', escapeHtml(r.original_title)]);
  rows.push(['Imprint', escapeHtml(imprint)]);
  if (r.edition) rows.push(['Edition', escapeHtml(r.edition)]);
  if (r.series) rows.push(['Series', searchLink(r.series)]);
  rows.push(['Language', escapeHtml(r.language)]);
  if (r.pages) rows.push(['Pages', escapeHtml(String(r.pages))]);
  if (r.isbn) rows.push(['ISBN', escapeHtml(r.isbn)]);
  if (r.notes) rows.push(['Notes', escapeHtml(r.notes)]);
  // Free copies first; Internet Archive lending copies need an account and are listed apart.
  const links = (r.links ?? []).filter((l) => isWeb(l.url));
  const free = links.filter((l) => !/^Borrow/.test(l.label));
  const lending = links.filter((l) => /^Borrow/.test(l.label));
  if (free.length) rows.push(['Read free', free.map((l) => link(l.url, l.label)).join(' · ')]);
  if (lending.length) rows.push(['Borrow', lending.map((l) => link(l.url, l.label.replace(/^Borrow /, ''))).join(' · ')]);
  if (r.copyright?.length) rows.push(['Copyright', r.copyright.map((c) => escapeHtml(`${c}.`)).join(' ')]);
  if (r.sources?.length) rows.push(['Sources', r.sources.map((s) => (isWeb(s.url) ? link(s.url, s.title) : escapeHtml(s.title))).join('; ')]);

  return `<p class="eyebrow">${link(`/publishers/${publisherId}`, publisher.name)} · ${escapeHtml(r.date)}</p>
    <h1${langAttr(r.language)}>${escapeHtml(r.title)}</h1>
    ${r.subtitle ? `<p class="lede"${langAttr(r.language)}>${escapeHtml(r.subtitle)}</p>` : ''}
    <p>${r.verified ? '<span class="badge verified">verified</span>' : '<span class="badge">unverified</span>'}</p>
    <dl class="record">${rows.map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${value}</dd>`).join('')}</dl>
    ${citeSection(r, publisherId, publisher)}
    ${reportSection(r, publisherId)}`;
}

/**
 * "Report an error": a form sent to the API (POST /api/report), with a script that sends it in
 * place, and without one a page thanking the reader. The "website" field is hidden from readers:
 * only a bot fills it in.
 */
function reportSection(r, publisherId) {
  return `<section class="report">
      <details>
        <summary>Report an error</summary>
        <form class="report-form" method="post" action="/api/report">
          <input type="hidden" name="p" value="${escapeHtml(publisherId)}">
          <input type="hidden" name="t" value="${escapeHtml(r.id)}">
          <fieldset>
            <legend>What is wrong with this record?</legend>
            ${Object.entries(KINDS).map(([value, label], i) => `<label><input type="radio" name="kind" value="${value}"${i === 0 ? ' required' : ''}> ${escapeHtml(label)}</label>`).join('\n            ')}
          </fieldset>
          <label class="report-message">Details (optional): what is wrong, and where you found the correct information
            <textarea name="message" rows="4" maxlength="${MAX_MESSAGE}"></textarea>
          </label>
          <div class="trap" aria-hidden="true"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
          <button type="submit" class="button">Send report</button>
          <p class="meta" data-report-status role="status"></p>
          <p class="meta">Reports are anonymous: nothing about you is kept.</p>
        </form>
      </details>
    </section>`;
}

/** "Cite this": the references in three styles, each to copy, and the record as BibTeX or RIS. */
function citeSection(r, publisherId, publisher) {
  const refs = references(r, publisher, escapeHtml);
  const file = (format) => `/api/cite?${new URLSearchParams({ p: publisherId, t: r.id, format })}`.replace(/&/g, '&amp;');
  return `<section class="cite" aria-labelledby="cite-heading">
      <h2 id="cite-heading">Cite this</h2>
      ${Object.entries(refs).map(([style, html]) => `<div class="citation">
        <p class="citation-style">${style}</p>
        <p class="citation-text" id="cite-${style.toLowerCase()}">${html}</p>
        <button type="button" class="button-small" data-copy="cite-${style.toLowerCase()}">Copy</button>
      </div>`).join('')}
      <p class="meta">For citation managers (Zotero, EndNote, Mendeley): <a href="${file('bibtex')}" download>BibTeX</a> · <a href="${file('ris')}" download>RIS</a>. Zotero's browser connector also reads this page directly.</p>
    </section>`;
}

/** The page's description, as search results show it. */
export function bookDescription(r, publisher) {
  const by = r.authors.length ? ` by ${names(r.authors.map((a) => a.name))}` : '';
  return `${r.title}${r.subtitle ? `: ${r.subtitle}` : ''}${by}. ${publisher.place}: ${publisher.name}, ${r.date}. ${r.language}.`;
}

/** schema.org data for the title: a Book with its authors, publisher, date and language. */
export function bookJsonLd(r, publisher, url) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Book',
    name: r.title,
    ...(r.subtitle ? { alternativeHeadline: r.subtitle } : {}),
    url,
    ...(r.authors.length ? { author: r.authors.map((a) => ({ '@type': 'Person', name: a.name })) } : {}),
    publisher: { '@type': 'Organization', name: publisher.name },
    ...(r.year ? { datePublished: String(r.year) } : {}),
    inLanguage: r.language,
    ...(r.isbn ? { isbn: r.isbn } : {}),
    ...(r.pages ? { numberOfPages: r.pages } : {}),
    ...(r.sources?.some((s) => isWeb(s.url)) ? { sameAs: r.sources.filter((s) => isWeb(s.url)).map((s) => s.url) } : {}),
  };
}

/**
 * The title's page: the template with its head describing the title, the record in its body, and
 * the address search engines should file it under (siteUrl + the title's path).
 */
export function renderBook(template, r, publisherId, publisher, siteUrl, path) {
  const url = `${siteUrl}${path}`;
  const title = escapeHtml(`${r.title} · Bibliotheca Marxista`);
  const description = escapeHtml(bookDescription(r, publisher));
  // Every replacement is a function: the record's text may contain "$", which a replacement string
  // would read as a pattern ("$1").
  const setMeta = (html, attr, name, value) =>
    html.replace(new RegExp(`(<meta ${attr}="${name}" content=")[^"]*(")`), (_, open, close) => open + value + close);
  let html = template
    .replace(/<title>[^<]*<\/title>/, () => `<title>${title}</title>`)
    // The template is a page kept out of search engines; this one is meant for them.
    .replace(/<meta name="robots"[^>]*>/, '')
    .replace(/(<link rel="canonical" href=")[^"]*(")/, (_, open, close) => open + escapeHtml(url) + close);
  html = setMeta(html, 'name', 'description', description);
  for (const [attr, name, value] of [
    ['property', 'og:title', escapeHtml(r.title)], ['property', 'og:description', description], ['property', 'og:url', escapeHtml(url)],
    ['property', 'og:type', 'book'], ['name', 'twitter:title', escapeHtml(r.title)], ['name', 'twitter:description', description],
  ]) html = setMeta(html, attr, name, value);
  // Structured data for search engines, and citation tags for Google Scholar and Zotero.
  html = html.replace('</head>', () => `<script type="application/ld+json">${safeJson(bookJsonLd(r, publisher, url))}</script>${citationMeta(r, publisher, escapeHtml)}</head>`);
  // The record, in place of the template's "Loading…".
  return html.replace(/<div class="title-record([^"]*)"([^>]*)>[\s\S]*?<\/div>/,
    (_, cls, attrs) => `<div class="title-record${cls}"${attrs} data-rendered>${bookBody(r, publisherId, publisher)}</div>`);
}
