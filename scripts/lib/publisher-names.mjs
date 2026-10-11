// Tidies publisher names as library catalogues record them: placeholders for an unknown publisher,
// English names in catalogue sentence case ("Oxford university press"), names in capitals, and
// names that open with a lower-case article or abbreviation ("l'Harmattan", "impr. de …").
// Names in other languages keep their own capitalisation after the first letter.

export const UNKNOWN_PUBLISHER = '[no publisher recorded]';

const PLACEHOLDER = /^\[?(s\.?\s?n\.?|sn|e|v|i\.\s?e|ch\.\s?o|o\.\s?fg\.?|ḥ\.\s?mo\.\s?l|publisher not identified|no publisher identified|[ée]diteur (inconnu|non identifi[ée])|wydawca nieznany|no publisher recorded)\]?$/i;

// Brands styled in lower case on purpose.
const STYLED = new Set(['e-flux', 'b_books', 'transcript', 'offen-siv', 'trafo', 'trainmedia', 'textuel', 'edition cimarron']);

const EXACT = {
  'de Gruyter GmbH, Walter': 'Walter de Gruyter', 'the Institue of materials': 'The Institute of Materials',
  "veda vydavatel'stvo slovenskej akadémie vied": 'Veda, vydavateľstvo Slovenskej akadémie vied', 'wydawnictwo literackie': 'Wydawnictwo Literackie',
  'the conde nast publication, inc': 'The Condé Nast Publications', 'the John Hopkins university press': 'The Johns Hopkins University Press',
  'c. Hanser,[1963?': 'C. Hanser', 'DIST. BY CASALINDA BOOKSHOP': 'Casalinda Bookshop', 'R. KURZ <SELBSTVERL.>': 'R. Kurz (Selbstverlag)',
  'LES LETTRES NOUVELLES': 'Les Lettres nouvelles', 'VENTS AILLEURS': "Vents d'ailleurs", 'FOLIES D ENCRE': "Folies d'encre", '8 NENTORI': '8 Nëntori',
  'M-EDITEUR': 'M-Éditeur', 'VERSO PUBLISHING': 'Verso', 'DEUTSCHER VERLAG DER WISSENSCHAFTEN': 'Deutscher Verlag der Wissenschaften',
  'VERLAG DIE WIRTSCHAFT': 'Verlag Die Wirtschaft', 'FEMINISTISCHE UITGEVERIJ SARA': 'Feministische Uitgeverij Sara', 'ARMAND COLIN': 'Armand Colin',
  'izdanie : Filipʺ Čipevʺ': 'Izdanie Filipʺ Čipevʺ', 'distributed by Pathfinder Press, 1979': 'Pathfinder Press',
  'In-house reproduction)': UNKNOWN_PUBLISHER, 'In-house reproduction': UNKNOWN_PUBLISHER, 'Victoria House Printing co.,ltd., amd The Labour Pub. co., ltd': 'Victoria House Printing Co. and the Labour Publishing Co.',
  'New York: Charles Scribner\'s Sons, 1948': "Charles Scribner's Sons", 'au bureau des "Temps nouveaux"': 'Au bureau des "Temps nouveaux"',
};
// Acronyms kept in capitals.
const ACRONYM = /^(ABC-CLIO|LLC|CLACSO|CODESRIA|FLACSO|UNRISD|UNESCO|CIEDUR|GEDISST|CIADEST|GRECMU|OGIZ|GIS|VSNH|SSSR|ESSR|AN|CEDREF|CRESFED|SLA|PZKO|DOSAAF|CONAMU|ADGENA|CEHILA|AAWORD|FAPESP|SEPHIS|CEPREMAP|HISBOL|EKOSOL|ROSSPEN|SUNY|CNRS|IMEC|RIO|NKVT|FARC|EP|ABC|CLIO|MIT|USA|UK|XXI|SED|UJ|CCAS|PAWF)$/;
const SMALL = new Set(['a', 'an', 'and', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'with', 'from', '&', 'de', 'der', 'die', 'des', 'du', 'la', 'le', 'et']);
// Linking words of imprint statements, kept in lower case: "in association with", "under the auspices of".
const PROSE = new Set(['collaboration', 'co-operation', 'cooperation', 'under', 'auspices', 'by', 'etc', 'etc.']);
// Words of another language that mark a name as not English.
const FOREIGN = /(^|\s)(au|aux|des|du|le|la|les|et|chez|del|della|delle|degli|der|die|das|und|y|el|los|las|och|og|het|een|impr\.|libr\.|éd\.|ed\.|tip\.|izd\.|nakł\.)(\s|$)/i;
const ENGLISH = /\b(press|books?|university|company|publishers?|publishing|house|library|society|institute|corporation|limited|sons|bookshop|foundation|review|news|center|centre|association|guild|agency|bureau|department|co|inc|ltd|cie)\b/;

const cap = (w) => w.replace(/^(\p{Ll})/u, (c) => c.toUpperCase());
const bare = (w) => w.replace(/^[("[]+|[)"\],.;:]+$/g, '');
// A word from a name in capitals: lower case with a capital, unless an acronym (each part of "STOCK/IMEC").
const fromCaps = (w, first) => {
  if (!first && SMALL.has(w.toLowerCase())) return w.toLowerCase();
  return w.split(/([-/])/).map((p) => (ACRONYM.test(bare(p)) ? p : cap(p.toLowerCase()))).join('').replace(/'S\b/g, "'s");
};
// A word from an English name in sentence case: a wholly lower-case word takes a capital; others stay.
const fromSentence = (w, first, prev) => {
  if (!/^[a-z]/.test(w) || /[A-Z]/.test(w)) return w;
  if (!first && (SMALL.has(bare(w)) || PROSE.has(bare(w)) || (w === 'association' && prev === 'in'))) return w;
  return w.split(/([-/])/).map((p) => cap(p)).join('');
};
const titleCase = (s, caps) => {
  let prev = '';
  return s.split(/(\s+)/).map((w, i) => {
    if (/^\s+$/.test(w)) return w;
    const out = caps ? fromCaps(w, i === 0) : fromSentence(w, i === 0, prev);
    prev = w.toLowerCase();
    return out;
  }).join('');
};

export function normalizePublisher(raw) {
  if (raw == null) return raw;
  if (EXACT[raw]) return EXACT[raw];
  const p = String(raw).trim()
    .replace(/\]\s*@$/, '').replace(/^(s\.\s?n\.?)\)$/i, '$1').replace(/\],?\s*\d{4}$/, '').replace(/,\s*\d{4}$/, '')
    .replace(/(?<=\S)\?$/, '').replace(/;?\s*\[?etc\.?,? etc\.?\]?$/i, '').replace(/,\s*etc\.?$/i, '')
    .replace(/^\[|\]$/g, '').trim();
  if (!p || PLACEHOLDER.test(p)) return UNKNOWN_PUBLISHER;
  if (EXACT[p]) return EXACT[p];
  if (STYLED.has(p)) return p;
  // All capitals (beyond acronyms): proper case word by word.
  const letters = p.replace(/[^\p{L}]/gu, '');
  if (letters.length > 5 && letters === letters.toUpperCase() && /\p{Lu}{4,}/u.test(p)) return titleCase(p, true);
  // English names in catalogue sentence case ("Oxford university press", "simon & schuster").
  const english = !FOREIGN.test(p) && /^[\x20-\x7E]+$/.test(p) && (ENGLISH.test(p) || (/^[a-z]/.test(p) && /&| and /.test(p)));
  if (english && p.split(/\s+/).some((w, i) => i > 0 && /^[a-z]/.test(w) && !SMALL.has(w) && !PROSE.has(w))) return cap(titleCase(p, false));
  // Otherwise only the first letter: "l'Harmattan" → "L'Harmattan", "al-Kātib" → "Al-Kātib".
  return cap(p);
}
