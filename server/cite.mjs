/**
 * Citations of a title: Chicago, MLA and APA references for its page, BibTeX and RIS files for
 * citation managers, and the citation_* tags (Highwire Press) that Google Scholar and Zotero read
 * from a page's head. Built from a title's record and its publisher.
 */

const CORPORATE = /\b(party|committee|congress|international|union|league|government|institute|council|society|association|bureau|front|movement|organi[sz]ation|ministry|academy|conference|commission|federation|soviet|press|publishers)\b/i;
const PARTICLES = new Set(['de', 'del', 'della', 'der', 'di', 'du', 'la', 'le', 'van', 'von', 'da', 'dos', 'das', 'ibn', 'bin', 'al']);

/**
 * A name split for citing: { family, given } for a person, { corporate } for an organisation.
 * Catalogue names are mostly "Given Family"; some are already "Family, Given".
 */
export function splitName(name) {
  const n = String(name).trim();
  if (CORPORATE.test(n)) return { corporate: n };
  if (n.includes(',')) {
    const [family, given] = n.split(/,\s*/, 2);
    return { family, given };
  }
  const words = n.split(/\s+/);
  if (words.length === 1) return { family: n, given: '' };
  // "Ludwig van Beethoven": the particle goes with the family name.
  let i = words.length - 1;
  while (i > 1 && PARTICLES.has(words[i - 1].toLowerCase())) i--;
  return { family: words.slice(i).join(' '), given: words.slice(0, i).join(' ') };
}
const inverted = (name) => {
  const s = splitName(name);
  return s.corporate ?? (s.given ? `${s.family}, ${s.given}` : s.family);
};
const initials = (given) => given.split(/[\s-]+/).filter(Boolean).map((g) => `${g[0]}.`).join(' ');
const apaName = (name) => {
  const s = splitName(name);
  return s.corporate ?? (s.given ? `${s.family}, ${initials(s.given)}` : s.family);
};
/** A sentence's end: a full stop, unless the text already ends in one ("V. I.", "n.d."). */
const period = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);
const list = (names, last = 'and') => (names.length <= 2 ? names.join(` ${last} `) : `${names.slice(0, -1).join(', ')}, ${last} ${names.at(-1)}`);
const fullTitle = (r) => (r.subtitle ? `${r.title}: ${r.subtitle}` : r.title);
/** The year as cited: the year, or the record's date note ("c. 1950"), or "n.d.". */
const citedYear = (r) => (r.year ? String(r.year) : r.date && r.date !== 'n.d.' ? r.date : 'n.d.');
const authorNames = (r) => (r.authors ?? []).map((a) => a.name);

/**
 * The references, as HTML (the title in italics), each a different style. `esc` escapes text for HTML.
 */
export function references(r, publisher, esc) {
  const authors = authorNames(r);
  const title = `<i>${esc(fullTitle(r))}</i>`;
  const place = publisher.place ? `${esc(publisher.place)}: ` : '';
  const year = esc(citedYear(r));
  const trans = r.translators?.length ? ` Translated by ${esc(list(r.translators))}.` : '';
  const eds = r.editors?.length ? ` Edited by ${esc(list(r.editors))}.` : '';

  // Chicago (bibliography): the first author inverted, the others as written.
  const chicagoAuthors = authors.length ? period(esc(list([inverted(authors[0]), ...authors.slice(1)]))) + ' ' : '';
  const chicago = `${chicagoAuthors}${title}.${eds}${trans}${r.edition ? ` ${esc(r.edition)}.` : ''} ${period(`${place}${esc(publisher.name)}, ${year}`)}`;

  // MLA 9: two authors joined with "and", three or more as the first "et al."
  const mlaAuthors = !authors.length ? '' : authors.length === 1 ? `${period(esc(inverted(authors[0])))} `
    : authors.length === 2 ? `${esc(inverted(authors[0]))}, and ${esc(authors[1])}. ` : `${esc(inverted(authors[0]))}, et al. `;
  const mlaTrans = r.translators?.length ? ` Translated by ${esc(list(r.translators))},` : '';
  const mla = `${mlaAuthors}${title}.${mlaTrans} ${period(`${esc(publisher.name)}, ${year}`)}`;

  // APA 7: family names with initials, the year in brackets.
  const apaAuthors = authors.length ? `${esc(list(authors.map(apaName), '&'))} ` : '';
  const apa = `${apaAuthors}(${year}). ${title}${r.translators?.length ? ` (${esc(list(r.translators))}, Trans.)` : ''}. ${esc(publisher.name)}.`;

  return { Chicago: chicago, MLA: mla, APA: apa };
}

const bibEscape = (s) => String(s).replace(/[\\{}]/g, (c) => `\\${c}`).replace(/[&%$#_]/g, (c) => `\\${c}`);
/** A BibTeX entry, keyed by the first author's family name and the year. */
export function bibtex(r, publisher, url) {
  const first = authorNames(r)[0];
  const keyName = first ? (splitName(first).family ?? splitName(first).corporate) : 'anon';
  const key = `${keyName}${r.year ?? ''}`.normalize('NFKD').replace(/[^A-Za-z0-9]/g, '') || 'book';
  const fields = [
    ['author', authorNames(r).map(inverted).join(' and ')],
    ['editor', (r.editors ?? []).join(' and ')],
    ['title', r.title],
    ['subtitle', r.subtitle],
    ['translator', (r.translators ?? []).join(' and ')],
    ['edition', r.edition],
    ['series', r.series],
    ['publisher', publisher.name],
    ['address', publisher.place],
    ['year', r.year ? String(r.year) : r.date_note],
    ['pages', r.pages ? String(r.pages) : undefined],
    ['isbn', r.isbn],
    ['language', r.language],
    ['url', url],
    ['note', 'Catalogued by Bibliotheca Marxista'],
  ].filter(([, v]) => v);
  return `@book{${key},\n${fields.map(([k, v]) => `  ${k} = {${bibEscape(v)}}`).join(',\n')}\n}\n`;
}

/** An RIS record. */
export function ris(r, publisher, url) {
  const lines = [['TY', 'BOOK'], ...authorNames(r).map((a) => ['AU', inverted(a)]), ...(r.editors ?? []).map((e) => ['ED', e]),
    ...(r.translators ?? []).map((t) => ['A4', t]), ['TI', fullTitle(r)], ['T3', r.series], ['ET', r.edition], ['PB', publisher.name],
    ['CY', publisher.place], ['PY', r.year ? String(r.year) : undefined], ['SP', r.pages ? String(r.pages) : undefined], ['SN', r.isbn],
    ['LA', r.language], ['UR', url], ['N1', 'Catalogued by Bibliotheca Marxista'], ['ER', '']];
  // Empty fields are left out; ER, the end of the record, has no value by definition.
  return lines.filter(([k, v]) => k === 'ER' || v)
    .map(([k, v]) => `${k}  - ${String(v).replace(/[\r\n]+/g, ' ')}`).join('\r\n') + '\r\n';
}

/** The citation_* tags for the page's head, as HTML. `esc` escapes attribute values. */
export function citationMeta(r, publisher, esc) {
  const tags = [['citation_title', fullTitle(r)], ...authorNames(r).map((a) => ['citation_author', inverted(a)]),
    ['citation_publication_date', r.year ? String(r.year) : undefined], ['citation_publisher', publisher.name],
    ['citation_isbn', r.isbn], ['citation_language', r.language]];
  return tags.filter(([, v]) => v).map(([name, v]) => `<meta name="${name}" content="${esc(v)}">`).join('');
}
