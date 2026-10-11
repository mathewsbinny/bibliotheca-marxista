/**
 * Decides what a reader's error report (server/reports.mjs) asks for. A report whose correction is
 * plain (one year, one quoted title, one language, a named broken link…) becomes a correction to
 * the title; any other is left for a maintainer, with the reason. The rules are cautious on
 * purpose: reports are anonymous, and the corrections they produce are still read in review (a
 * pull request) before they reach the site.
 */
import { LANG_CODES } from '../../server/book.mjs';

const LANGUAGES = ['English', ...Object.keys(LANG_CODES)];
const URL_PATTERN = /https?:\/\/[^\s<>"“”«»]+[^\s<>"“”«».,;:!?)]/gi;
const MAX_REVIEWED = 600;
const HEDGES = /\b(not sure|unsure|maybe|perhaps|possibly|probably|i think|i believe|might be|could be)\b|\?/i;
const BROKEN = /\b(broken|dead|404|not found|doesn'?t work|does not work|no longer|unavailable|removed|gone)\b/i;

const fold = (s) => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const words = (s) => new Set(fold(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3));
const urlsIn = (s) => s.match(URL_PATTERN) ?? [];
const sameUrl = (a, b) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
const manual = (reason) => ({ action: 'manual', reason });
const apply = (summary, change) => ({ action: 'apply', summary, ...change });

/**
 * The value a report proposes: the quoted text (after "should be" when there are several), or the
 * words after "should be", "should read", "correct … is", "is actually".
 */
export function proposedValue(message) {
  const quoted = [...message.matchAll(/["“„«]([^"“”„«»]{1,300})["”“»]/g)].map((m) => m[1].trim());
  const after = /(?:should be|should read|should say|correct(?:ed)?(?: \w+)? (?:is|to)|is actually|real \w+ is|instead of [^,]+,)\s*:?\s*/i;
  if (quoted.length === 1) return quoted[0];
  if (quoted.length > 1) {
    const m = after.exec(message);
    if (!m) return undefined;
    const next = /["“„«]([^"“”„«»]{1,300})["”“»]/.exec(message.slice(m.index));
    return next?.[1].trim();
  }
  const m = after.exec(message);
  if (!m) return undefined;
  const rest = message.slice(m.index + m[0].length).trim();
  // One statement only: a second sentence may say something the rules cannot weigh.
  if (/[.!;]\s+\S/.test(rest)) return undefined;
  return rest.replace(/[.!;]+$/, '').trim() || undefined;
}

const plausibleName = (name) => name.length >= 2 && name.length <= 120 && /\p{L}/u.test(name)
  && !/https?:|www\.|@|\d{3,}/i.test(name) && name.split(/\s+/).length <= 8;

function dateReport(message, r) {
  if (/\b(c\.|ca\.|circa|\d{4}s)\b|\d{4}s/i.test(message)) return manual('the report gives an approximate date');
  const now = new Date().getFullYear();
  const years = [...new Set((message.match(/\b(1[789]\d\d|20\d\d)\b/g) ?? []).map(Number))].filter((y) => y <= now && y !== r.year);
  if (years.length !== 1) return manual(years.length ? 'the report names more than one year' : 'the report names no other year');
  return apply(`year ${r.year ?? '(none)'} → ${years[0]}`, { set: { year: years[0] } });
}

function titleReport(message, r) {
  const value = proposedValue(message);
  if (!value) return manual('the report does not say what the title should be (quote it, or write "should be …")');
  const current = [r.title, r.subtitle].filter(Boolean).join(': ');
  const subtitleOnly = /\bsub-?title\b/i.test(message) && !/\btitle\b/i.test(message.replace(/\bsub-?title\b/gi, ''));
  if (value === (subtitleOnly ? r.subtitle : current) || value === r.title) return manual('the proposed text is what the record already says');
  const shared = [...words(value)].some((w) => words(current).has(w));
  if (!shared && words(current).size) return manual('the proposed title shares no word with the current one');
  if (subtitleOnly) return apply(`subtitle → “${value}”`, { set: { subtitle: value } });
  // The catalogue keeps a subtitle apart from its title.
  const cut = value.indexOf(': ');
  const set = cut > 0 ? { title: value.slice(0, cut), subtitle: value.slice(cut + 2) } : { title: value };
  return apply(`title → “${value}”`, { set });
}

function authorReport(message, r) {
  const value = proposedValue(message) ?? /\b(?:author is|written by|authored by|missing author:?|add author:?)\s+(.+)$/i.exec(message)?.[1]?.replace(/[.!]+$/, '');
  if (!value) return manual('the report does not name the author (quote the name, or write "should be …")');
  const names = value.split(/\s*(?:;|\s&\s|\sand\s)\s*/).map((s) => s.trim()).filter(Boolean);
  if (!names.length || !names.every(plausibleName)) return manual('the proposed name does not look like a name');
  const current = r.authors.map((a) => a.name ?? a);
  const adding = /\b(missing|add|also|co-?author|as well)\b/i.test(message);
  const authors = adding ? [...current, ...names.filter((n) => !current.includes(n))] : names;
  if (authors.join('|') === current.join('|')) return manual('the proposed authors are those the record already has');
  return apply(`authors ${current.join('; ') || '(none)'} → ${authors.join('; ')}`, { set: { authors } });
}

function languageReport(message, r) {
  const named = LANGUAGES.filter((l) => new RegExp(`\\b${l}\\b`, 'i').test(message) && l !== r.language);
  if (named.length !== 1) return manual(named.length ? 'the report names more than one language' : 'the report names no other language');
  return apply(`language ${r.language} → ${named[0]}`, { set: { language: named[0] } });
}

function linkReport(message, r) {
  const links = r.links ?? [];
  const urls = urlsIn(message);
  const known = urls.filter((u) => links.some((l) => sameUrl(l.url, u)));
  const fresh = urls.filter((u) => !known.includes(u));
  const without = (url) => links.filter((l) => !sameUrl(l.url, url));
  if (known.length === 1 && fresh.length === 1) {
    // A page that moved within the same site; a link to another site is a maintainer's call.
    const [old, next] = [new URL(known[0]), new URL(fresh[0])];
    if (old.hostname !== next.hostname) return manual('the proposed link is on another site');
    return apply(`link ${known[0]} → ${fresh[0]}`, { set: { links: links.map((l) => (sameUrl(l.url, known[0]) ? { ...l, url: fresh[0] } : l)) } });
  }
  if (!BROKEN.test(message)) return manual('the report does not say the link is broken, nor give its new address');
  if (known.length === 1 && !fresh.length) return apply(`remove broken link ${known[0]}`, { set: { links: without(known[0]) } });
  if (!urls.length && links.length === 1) return apply(`remove broken link ${links[0].url}`, { set: { links: [] } });
  return manual('the report does not say which link is broken');
}

const slugTitle = (r) => fold(r.title).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function duplicateReport(message, r, others) {
  const hrefs = [...message.matchAll(/\/book\/([a-z0-9-]+)\/([\p{L}\p{N}-]+)/gu)].map((m) => m[0]).filter((h) => h !== r.href);
  if (hrefs.length !== 1) return manual(hrefs.length ? 'the report names more than one other title' : 'the report does not give the other title\'s address (/book/…)');
  const other = others?.[hrefs[0]];
  if (!other) return manual('the other title is not in the catalogue');
  if (other.publisherId !== r.publisherId) return manual('the other title belongs to another publisher');
  if (slugTitle(other) !== slugTitle(r) || (other.year && r.year && other.year !== r.year)) return manual('the two titles differ in title or year');
  // Keep the better record: a verified one, or else the one with more sources.
  const score = (t) => (t.verified ? 1000 : 0) + (t.sources?.length ?? 0);
  const drop = score(other) > score(r) ? r : other;
  return apply(`remove duplicate ${drop.href} (kept ${drop === r ? other.href : r.href})`, { id: drop.id, remove: true });
}

/**
 * What to do with a report: { action: 'apply', summary, set | remove, id? } or { action: 'manual', reason }.
 * `report` is a report with `record` (the title as the catalogue database holds it, with `href` and
 * `publisherId`) and `others` (records of titles its message names, by address).
 */
export function decide(report) {
  const r = report.record;
  const message = String(report.message ?? '').trim();
  if (!r) return manual('the title is no longer in the catalogue');
  if (['publisher', 'scope', 'other'].includes(report.kind)) return manual('this kind of report needs a maintainer\'s judgement');
  if (!message && report.kind !== 'link') return manual('the report gives no correction');
  if (message.length > MAX_REVIEWED) return manual('the report is long; read it');
  if (HEDGES.test(message.replace(URL_PATTERN, ''))) return manual('the report is unsure');
  switch (report.kind) {
    case 'date': return dateReport(message, r);
    case 'title': return titleReport(message, r);
    case 'author': return authorReport(message, r);
    case 'language': return languageReport(message, r);
    case 'link': return linkReport(message, r);
    case 'duplicate': return duplicateReport(message, r, report.others);
    default: return manual(`unknown kind of report "${report.kind}"`);
  }
}
