/**
 * The key a person's name is compared by, wherever names are matched: the site's author pages
 * (src/lib/catalogue.ts) and the scripts that find authors' spellings. Plain JavaScript, so the
 * scripts can import it as well as the site.
 *
 * Dates go ("Marx, Karl, 1818-1883"), an inverted name is turned round ("Marx, Karl" is "Karl
 * Marx"), accents, case and punctuation are ignored, and romanisations of one Russian name are
 * folded together.
 */

/**
 * Romanisations of one Russian name, compared as one: library "Pokrovskiĭ", "Mintz", "Leont'ev"
 * and English "Pokrovsky", "Mints", "Leontyev".
 * @param {string} w
 */
function foldRomanisation(w) {
  return w
    .replace(/(sk|ck|tsk)(ii|iy|ij|y)$/, '$1y')
    .replace(/([^aeiou])(iev|yev|jev)$/, '$1ev')
    .replace(/tz/g, 'ts')
    .replace(/x/g, 'ks')
    .replace(/yu/g, 'iu')
    .replace(/ya/g, 'ia');
}

/** @param {string} name */
export function computeNameKey(name) {
  let n = String(name).replace(/,?\s*\(?\d{4}\s*-\s*(\d{4})?\)?\.?/g, '').trim();
  const parts = n.split(/\s*,\s*/);
  if (parts.length === 2) n = `${parts[1]} ${parts[0]}`;
  return n
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Apostrophes and the soft and hard signs ("Leont'ev", "Leontʹev") are dropped, not spaced.
    .replace(/['’ʹʼʺ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .map(foldRomanisation)
    .join(' ');
}
