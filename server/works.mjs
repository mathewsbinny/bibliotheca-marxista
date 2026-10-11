/**
 * Editions grouped as works: The State and Revolution from Progress Publishers, Staat und
 * Revolution from Dietz and Gosudarstvo i revoliutsiia from Politizdat are one work, by one author.
 *
 * An edition's work is named by its author and the title it translates (original_title, for a
 * translation; else its own title), compared loosely: accents, case, punctuation, a leading
 * article and a subtitle are ignored, Cyrillic is romanised, and the romanisations libraries use
 * (ALA-LC "revoliutsiia", ISO 9 "revoljucija", German "Revoljuzija") are folded together.
 * Editions without an author are not grouped: a bare title ("Selected Works", "Speeches") says
 * too little.
 */

const CYRILLIC = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm',
  н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'iu', я: 'ia', і: 'i', ї: 'i', є: 'e', ґ: 'g', ў: 'u', ђ: 'dj', ј: 'j', љ: 'lj',
  њ: 'nj', ћ: 'c', џ: 'dz', ѓ: 'g', ќ: 'k', ѕ: 'dz',
};
// Letters whose romanisations differ, folded to one spelling (the order matters: "shch" before "sh").
const FOLDS = [
  [/ŝ|šč/g, 'shch'], [/č/g, 'ch'], [/š/g, 'sh'], [/ž/g, 'zh'], [/ë/g, 'e'],
  [/x/g, 'kh'], [/tsch/g, 'ch'], [/sch/g, 'sh'], [/zh/g, 'z'], [/kh/g, 'h'], [/ch/g, 'h'],
  [/ts|tz|z(?=[aeiou])/g, 'c'], [/j|y/g, 'i'], [/ii+/g, 'i'], [/w/g, 'v'], [/(.)\1/g, '$1'],
];
const ARTICLES = /^(the|a|an|der|die|das|ein|eine|le|la|les|l|un|une|el|los|las|lo|il|gli|i|o|os|as|de|het)\s+/;

/** A title as works compare it. */
export function workTitle(title) {
  let s = String(title ?? '').split(/\s*[:;=]\s+|\s+[/(]\s*/)[0].toLowerCase();
  s = s.replace(/[а-яёіїєґўђјљњћџѓќѕ]/g, (c) => CYRILLIC[c] ?? c);
  s = s.normalize('NFC');
  for (const [re, to] of FOLDS.slice(0, 5)) s = s.replace(re, to);
  s = s.normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(ARTICLES, '');
  for (const [re, to] of FOLDS.slice(5)) s = s.replace(re, to);
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * The key of an edition's work, or undefined when it cannot be grouped: its first author (their
 * page's id, else their name as works compare titles) and the title it translates.
 */
export function workKey({ title, original_title, author_links, authors_text }) {
  const links = typeof author_links === 'string' ? JSON.parse(author_links) : author_links ?? [];
  const [name, id] = links[0] ?? [];
  const author = id ? `@${id}` : workTitle(name ?? String(authors_text ?? '').split(/,| & /)[0]);
  const work = workTitle(original_title || title);
  if (!author || !work || work.length < 3) return undefined;
  return `${author}|${work}`;
}
