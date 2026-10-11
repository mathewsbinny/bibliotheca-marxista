#!/usr/bin/env node
/**
 * Imports publisher backlists from Open Library and verifies hand-entered titles.
 *
 *   node scripts/import-openlibrary.mjs            # dry run: fetch, match, write report only
 *   node scripts/import-openlibrary.mjs --write    # also write data/catalogues/<id>/openlibrary.yaml
 *                                                  # and mark verified hand-entered titles
 *
 * Verification rule: an edition is `verified: true` only when its Open Library record was
 * derived from a library catalogue (a MARC source record, OCLC number or LCCN) AND its imprint
 * names the publisher, a matching place (or MARC country code) and a year within the house's
 * years of operation. Anything ambiguous is left out and listed in reports/import-review.md.
 *
 * API responses are cached in .cache/openlibrary so re-runs are fast and polite.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as yaml from 'js-yaml';
import { addFreeAccess, freeAccessRequests } from './lib/free-access.mjs';
import { screenTitle } from './lib/not-left.mjs';
import { HOUSES as MARXIST_HOUSES, marxistRules } from './lib/marxist-houses.mjs';
import { bannedThoughtItems, bnfRecords, ciniiRecord, ciniiSearch, ciniiTotal, dnbRecords, sudocRecords, swissRecords, locRecords, polishRecords, internetArchiveItems, ndlRecords, k10plusRecords, k10plusCount, b3katRecords, b3katCount, bneRecords, bneCount, hathiRecords, sourceRequests } from './lib/sources.mjs';
import {
  OL, ROOT, authorNames, catalogueSources, clean, discoverImprints, editionsByPublisher, editionsForTitle,
  authorAlternates, authorsFromStatement, authorsOverlap, displayAuthor, formatTitle, polishTitle, polishCredit, splitCredits, groupDuplicates, isCatalogued,
  resolveWorkAuthors, secondaryNames, surname, workAuthors, isEnglishTitle, foreignTitleLanguage, patchListFile, requestCount, resolveAuthors, titleKey,
  titlesMatch, yearOf,
} from './lib/openlibrary.mjs';

const CATALOGUES = join(ROOT, 'data', 'catalogues');
const GENERATED = 'openlibrary.yaml';
const WRITE = process.argv.includes('--write');

// --budget=<minutes>: stop without writing once the time is used up. Responses are cached, so the
// next run continues where this one stopped; the run that finishes inside its budget writes the files.
// --offline=archive.org: use only cached responses from hosts that are down (see isOffline).
const offlineArg = process.argv.find((a) => a.startsWith('--offline='));
if (offlineArg) process.env.LEFT_BACKLIST_OFFLINE = offlineArg.split('=')[1];
const BUDGET_MS = Number((process.argv.find((a) => a.startsWith('--budget=')) ?? '=').split('=')[1]) * 60_000 || Infinity;
const startedAt = Date.now();
function checkBudget() {
  if (Date.now() - startedAt < BUDGET_MS) return;
  console.log(`Time budget reached after ${requestCount()} requests; nothing written. Run again to continue from the cache.`);
  process.exit(3);
}

// ---------------------------------------------------------------------------
// Publisher matching rules
// ---------------------------------------------------------------------------

const MOSCOW = /mosc|moskv|moskau|moskow|mosk\b|moscú|mosca/i;
const PEKING = /peking|bei\s*jing|p[ée]kin|pequ[ií]n|peiping|pechino|北京/i;
const NEW_YORK = /new\s*york|nueva\s*york|\bn\.\s*y\b/i;
// The foreign-languages presses' French, Spanish and German imprints; the place of publication
// decides which house (Moscow, Peking, Hanoi, Pyongyang) an edition belongs to.
const FL_OTHER = '(ediciones\\s+en\\s+lenguas?\\s+extranjer[ae]s|(é|e)ditions\\s+en\\s+langues?\\s+(é|e)trang(è|e)res|verlag\\s+f(ü|u)r\\s+fremdsprachige\\s+literatur)';
const FLPH = new RegExp(`^(foreign\\s+languages?\\s+(pub\\w*\\.?|publishing)\\s*(house|h\\.)|${FL_OTHER})`, 'i');
const FLP = new RegExp(`^(foreign\\s+languages?\\s+press|wai\\s*wen\\s*chu\\s*ban\\s*she|外文出版社|${FL_OTHER})`, 'i');
// The same name in the languages Pyongyang and Sofia printed it in, without Beijing's own name in
// Chinese and pinyin: CiNii gives no place, so "外文出版社" must point to Beijing alone.
const FLP_ABROAD = new RegExp(`^(foreign\\s+languages?\\s+press|${FL_OTHER})`, 'i');
const FL_OTHER_SEARCH = ['Ediciones en Lenguas Extranjeras', 'Éditions en langues étrangères', 'Verlag für fremdsprachige Literatur'];

/**
 * The Beijing foreign-language presses' Chinese-language books since 1990 are general
 * domestic publishing, outside their role of publishing for readers abroad.
 */
const recentChinese = (t) => t.language.split(', ')[0] === 'Chinese' && (t.year ?? 0) >= 1990;

/**
 * search:  loose Open Library search terms used to discover imprint spellings
 * match:   regex an edition's publisher string must match
 * place:   regex its place of publication must match…
 * country: …or, when no place is recorded, one of these MARC country codes
 * years:   inclusive range of plausible imprint years
 * exclude: optional predicate dropping matched titles outside the collection's scope
 * yieldTo: houses that keep an edition this house also lists (e.g. a club or an imprint of it)
 */
const PUBLISHERS = [
  {
    // Co-operative Publishing Society of Foreign Workers in the USSR (1931–1938), then FLPH (1938–1963).
    id: 'foreign-languages-publishing-house-moscow',
    search: [
      'Foreign Languages Publishing House', 'Foreign Languages Pub. House', 'Foreign Language Publishing House',
      'Co-operative Publishing Society of Foreign Workers', ...FL_OTHER_SEARCH,
    ],
    // Also the Russian imprint, "Izd-vo lit-ry na inostrannykh i︠a︡zykakh" or in Cyrillic.
    match: new RegExp(`${FLPH.source}|^co-?operative\\s+pub\\w*\\.?\\s+soc\\w*\\.?\\s+of\\s+foreign\\s+workers|^izd\\S*\\s+lit\\S*\\s+na\\s+inostrann\\S*\\s+\\S*zyk|^изд\\S*\\s+лит\\S*\\s+на\\s+иностранных\\s+языках`, 'i'),
    place: MOSCOW, country: ['ru', 'ur'], years: [1931, 1964],
  },
  {
    // Foreign Languages Publishing House (1957–1992), then Thế Giới Publishers.
    id: 'foreign-languages-publishing-house-hanoi',
    search: ['The Gioi Publishers', 'Thế Giới'],
    match: new RegExp(`${FLPH.source}|^(nh[aà]\\s+xu[aấ]t\\s+b[aả]n\\s+)?th[eế]\\s*gi[oớ]i(\\s+pub\\w*)?`, 'i'),
    place: /h[aà]\s*n[oộ]i/i, country: ['vm'], years: [1957, 2030],
  },
  {
    id: 'foreign-languages-publishing-house-pyongyang',
    search: [],
    // Also its Korean name, 외국문(종합)출판사, which only CiNii and the NDL record.
    match: new RegExp(`${FLPH.source}|${FLP_ABROAD.source}|^외국문(종합)?출판사`, 'i'),
    place: /p.?y[oŏ]ng.?yang|korea/i, country: ['kn'], years: [1949, 2030],
  },
  // The state houses of the Lao People's Democratic Republic and of the People's Republic of
  // Kampuchea, whose books the Library of Congress romanises ("Samnakphim læ Chamnāi Pư̄m",
  // "Hōngphim hǣng Lat"); the foreign-language houses are left out of the name searches, as
  // "Foreign Languages Publishing House" alone would find Moscow's, Hanoi's and Pyongyang's books.
  {
    id: 'lao-state-publishing-house',
    search: ['Samnakphim Chamnai', 'Samnakphim lae Chamnai'],
    match: /^samnakphim\s+(\S+\s+)?chamn\S*i|^ສໍານັກພິມ\s*(ແລະ\s*)?ຈໍາໜ່າຍ/i,
    place: /vientiane|v[iī]angchan|laos|lao\s+pdr/i, country: ['ls'], years: [1975, 2000], allowNoPlace: true,
  },
  {
    id: 'lao-state-printing-house',
    search: ['Hongphim haeng Lat', 'Hongphim haeng Sat'],
    match: /^h\S*ngphim\s+h\S*ng\s+(l\S*t|s\S*t)\b|^ໂຮງພິມແຫ່ງລັດ/i,
    place: /vientiane|v[iī]angchan|laos/i, country: ['ls'], years: [1975, 2000], allowNoPlace: true,
  },
  {
    id: 'foreign-languages-publishing-house-vientiane',
    search: [],
    match: new RegExp(`${FLPH.source}|^${FL_OTHER}`, 'i'),
    place: /vientiane|v[iī]angchan|laos|rdpl/i, country: ['ls'], years: [1975, 2000],
  },
  {
    id: 'foreign-languages-publishing-house-phnom-penh',
    search: [],
    match: new RegExp(`${FLPH.source}|^${FL_OTHER}`, 'i'),
    place: /phnom\s*penh|bhna\S*\s*be\S*|kampuchea|cambodia/i, country: ['cb'], years: [1979, 1995],
  },
  // Hanoi's state houses of literature, of the youth union and of the social sciences institute.
  {
    id: 'van-hoc-hanoi',
    search: ['Văn học', 'Nhà xuất bản Văn học'],
    match: /^[\s\["“”«»'(]*((nh[àa]\s+xu\S*\s+b[ảa]n\s+)?v[ăa]n\s+h[ọo]c)[\s\]"“”«»'),.;:]*$/i,
    place: /h[àa][\s-]*n[ộọo]i|hanoi/i, country: ['vm'], years: [1948, 1995],
  },
  {
    id: 'thanh-nien-hanoi',
    search: ['Thanh niên', 'Nhà xuất bản Thanh niên'],
    match: /^[\s\["“”«»'(]*((nh[àa]\s+xu\S*\s+b[ảa]n\s+)?thanh\s+ni[êe]n)[\s\]"“”«»'),.;:]*$/i,
    place: /h[àa][\s-]*n[ộọo]i|hanoi/i, country: ['vm'], years: [1954, 1995],
  },
  {
    id: 'khoa-hoc-xa-hoi-hanoi',
    search: ['Khoa học xã hội', 'Nhà xuất bản Khoa học xã hội'],
    match: /^[\s\["“”«»'(]*((nh[àa]\s+xu\S*\s+b[ảa]n\s+)?khoa\s+h[ọo]c\s+x[ãa]\s+h[ộo]i)[\s\]"“”«»'),.;:]*$/i,
    place: /h[àa][\s-]*n[ộọo]i|hanoi/i, country: ['vm'], years: [1960, 1995],
  },
  // Pyongyang's house of the party's mass organizations, and its academic and encyclopedia house.
  {
    id: 'kullo-tanche-chulpansa',
    search: ["Kŭllo Tanch'e Ch'ulp'ansa", 'Kullo Tanche Chulpansa'],
    match: /^(k[uŭ]llo\s*tanch\S*e\s*ch\S*ul\S*p\S*ansa|근로단체출판사)\.?$/i,
    place: /p.?y[oŏ]ng.?yang|평양/i, country: ['kn'], years: [1946, 2030],
  },
  {
    id: 'kwahak-paekkwa-sajon-chulpansa',
    search: ["Kwahak Paekkwa Sajŏn Ch'ulp'ansa", "Kwahak Paekkwa Sajŏn Chonghap Ch'ulp'ansa"],
    match: /^(kwahak\s*paekkwa\s*saj[oŏ]n(\s*chonghap)?\s*ch\S*ul\S*p\S*ansa|과학백과사전(종합)?출판사)\.?$/i,
    place: /p.?y[oŏ]ng.?yang|평양/i, country: ['kn'], years: [1950, 2030],
  },
  {
    id: 'workers-party-of-korea-publishing-house',
    search: ["Chosŏn Rodongdang Ch'ulp'ansa", 'Choson Rodongdang Chulpansa', "Workers' Party of Korea Publishing House"],
    match: /^(chos[oŏ]n\s*rodongdang\s*ch.?ul.?p.?ansa|joseon\s*rodongdang\s*chulpansa|workers'?\s+party\s+of\s+korea\s+pub\w*\.?\s+house|조선로동당출판사)\.?$/i,
    place: /p.?y[oŏ]ng.?yang|korea/i, country: ['kn'], years: [1945, 2030],
  },
  {
    id: 'literature-and-art-publishing-house-pyongyang',
    search: ["Munye Ch'ulp'ansa", "Munye Chʻulpʻansa", "Munhak Yesul Chonghap Ch'ulp'ansa", "Munhak Yesul Ch'ulp'ansa"],
    match: /^(munye\s*ch\S*ul\S*p\S*ansa|munhak\s*yesul(\s*chonghap)?\s*ch\S*ul\S*p\S*ansa|문예출판사|문학예술(종합)?출판사|literature\s+and\s+art\s+pub\w*\s+house)\.?$/i,
    place: /p.?y[oŏ]ng.?yang/i, country: ['kn'], years: [1946, 2030],
  },
  {
    id: 'korean-writers-union-publishing-house',
    search: ['Chakka Tongmaeng'],
    match: /^(chos[oŏ]n\s*)?chakka\s*tongmaeng(\s*ch\S*ul\S*p\S*ansa)?\.?$|^조선작가동맹(출판사)?$/i,
    place: /p.?y[oŏ]ng.?yang/i, country: ['kn'], years: [1946, 2030],
  },
  {
    id: 'kumsong-youth-publishing-house',
    search: ["Kŭmsŏng Ch'ŏngnyŏn", "Kumsong Ch'ongnyon"],
    match: /^k[uŭ]ms[oŏ]ng\s*ch\S*[oŏ]ngny[oŏ]n(\s*ch\S*ul\S*p\S*ansa)?\.?$|^금성청년출판사$/i,
    place: /p.?y[oŏ]ng.?yang/i, country: ['kn'], years: [1946, 2030],
  },
  {
    id: 'foreign-languages-press-beijing',
    search: ['Foreign Languages Press', 'Wai wen chu ban she'],
    exclude: recentChinese,
    match: FLP, place: PEKING, country: ['cc'], years: [1952, 2030],
  },
  {
    id: 'progress-publishers',
    search: ['Progress Publishers', 'Progress'],
    // Its foreign-language editions' imprints too: "Editorial Progreso", "Éditions du Progrès", "Edizioni Progresso".
    match: /^((editorial|ediciones|[ée]ditions\s+du|edizioni|edi[çc][õo]es|verlag)\s+)?(progress(\s+pub\w*\.?)?|progreso|progr[èe]s|progresso)\.?$|^(изд(-во|ательство)\s+)?[«"„]?прогресс[»"“]?\.?$/i, place: MOSCOW, country: ['ru', 'ur'], years: [1963, 1993],
  },
  {
    id: 'new-world-press-beijing',
    search: ['New World Press', 'Xin shi jie chu ban she'],
    match: /^(new\s+world\s+press|xin\s*shi\s*jie\s*chu\s*ban\s*she|新世界出版社)\.?$/i, place: PEKING, country: ['cc'], years: [1951, 2030],
    exclude: recentChinese,
  },
  {
    id: 'international-publishers',
    search: ['International Publishers'],
    match: /^international\s+pub(lishers|s?\.)?\s*(co\.?|company)?\.?$/i, place: NEW_YORK, country: ['nyu', 'xxu'], years: [1924, 2030],
  },
  {
    id: 'monthly-review-press',
    search: ['Monthly Review Press'],
    match: /^monthly\s+review(\s+press)?\.?$/i, place: /new\s*york|london|\bn\.\s*y\b/i, country: ['nyu', 'xxu'], years: [1952, 2030],
    allowNoPlace: true,
  },
  {
    id: 'leftword-books',
    search: ['LeftWord Books', 'LeftWord'],
    match: /^left\s?word(\s+books)?\.?$/i, place: /delhi/i, country: ['ii'], years: [1999, 2030],
    allowNoPlace: true,
  },
  {
    id: 'seven-seas-books',
    search: ['Seven Seas Publishers', 'Seven Seas Books'],
    match: /^seven\s+seas(\s+(pub\w*|books))?\.?$/i, place: /berlin/i, country: ['ge'], years: [1958, 1981],
  },
  {
    id: 'lawrence-and-wishart',
    search: ['Lawrence & Wishart', 'Lawrence and Wishart'],
    match: /^lawrence\s*(&|and)\s*wishart(\s+ltd)?\.?$/i, place: /london|england/i, country: ['enk', 'xxk'], years: [1936, 2030],
    allowNoPlace: true,
  },
  {
    id: 'vanguard-press',
    search: ['Vanguard Press'],
    match: /^(the\s+)?vanguard\s+press(,?\s+inc\.?)?\.?$/i, place: NEW_YORK, country: ['nyu', 'xxu'], years: [1926, 1988],
    allowNoPlace: true,
  },
  {
    // Limited to Victor Gollancz's lifetime; the later list is mostly genre fiction.
    id: 'victor-gollancz',
    yieldTo: ['left-book-club'],
    search: ['Gollancz', 'Victor Gollancz', 'V. Gollancz'],
    match: /^(v(ictor)?\.?\s*)?gollancz(,?\s+(ltd|limited)\.?)?\.?$/i, place: /london/i, country: ['enk', 'xxk'], years: [1927, 1967],
    allowNoPlace: true,
  },
  {
    id: 'martin-lawrence',
    search: ['Martin Lawrence'],
    match: /^martin\s+lawrence(,?\s+(ltd|limited)\.?)?\.?$/i, place: /london/i, country: ['enk', 'xxk'], years: [1925, 1937],
    allowNoPlace: true,
  },
  {
    // New Left Books (NLB) from 1970; Verso its paperback, then sole, imprint.
    id: 'verso-books',
    search: ['Verso', 'New Left Books', 'NLB'],
    match: /^(verso(\s+books)?|nlb|new\s+left\s+books)\.?$/i, place: /london|new\s*york|brooklyn/i,
    country: ['enk', 'xxk', 'nyu', 'xxu'], years: [1970, 2030], allowNoPlace: true,
  },
  {
    id: 'haymarket-books',
    search: ['Haymarket Books'],
    match: /^haymarket(\s+books)?\.?$/i, place: /chicago/i, country: ['ilu', 'xxu'], years: [2001, 2030], allowNoPlace: true,
  },
  {
    // Formerly Labor Publications (the Workers League's imprint).
    id: 'mehring-books',
    search: ['Mehring Books', 'Labor Publications'],
    match: /^(mehring(\s+books)?|labor\s+publications(,?\s+inc\.?)?)\.?$/i, place: /detroit|oak\s+park|southfield|michigan|new\s*york/i,
    country: ['miu', 'nyu'], years: [1970, 2030],
  },
  {
    id: 'peoples-publishing-house-india',
    search: ["People's Publishing House"],
    match: /^people'?s\s+pub(lishing|l?\.)?\s*house(\s+(pvt\.?\s+)?ltd\.?)?\.?$/i, place: /bombay|mumbai|delhi/i,
    country: ['ii'], years: [1942, 2030],
  },
  {
    // Renmin chubanshe; limited to 1990, as the later list is general Chinese-language publishing.
    id: 'peoples-publishing-house-beijing',
    search: ['Ren min chu ban she', "People's Publishing House"],
    match: /^(ren\s*min\s*chu\s*ban\s*she|人民出版社|jen\s*min\s*ch.?u\s*pan\s*she|people'?s\s+pub(lishing)?\s+house)\.?$/i,
    place: PEKING, country: ['cc'], years: [1950, 1990],
  },
  {
    id: 'zer0-books',
    search: ['Zero Books', 'Zer0 Books'],
    match: /^zer[o0]\s*books\.?$/i, place: /winchester|alresford|ropley|hampshire|hants|washington|london|england|\bu\.?k\.?\b/i,
    country: ['enk', 'xxk'], years: [2009, 2030], allowNoPlace: true,
  },
  {
    // Pioneer Publishers (1930–1965), Merit Publishers (1965–1969), then Pathfinder Press.
    id: 'pathfinder-press',
    search: ['Pathfinder Press', 'Pioneer Publishers', 'Merit Publishers'],
    match: /^(pathfinder(\s+press)?|pioneer\s+publishers|merit\s+publishers)\.?$/i, place: NEW_YORK,
    country: ['nyu'], years: [1930, 2030],
  },

  // --- Fraternal foreign-language presses -----------------------------------
  {
    id: 'foreign-languages-press-sofia',
    search: [],
    match: FLP_ABROAD, place: /sof[ií]j?a|софия/i, country: ['bu'], years: [1950, 1970],
  },
  {
    // Successor to the Foreign Languages Press, c. 1967–1990.
    id: 'sofia-press',
    search: ['Sofia Press', 'Sofia-Press'],
    match: /^(sofi[ai]a?[-\s]?press|софия[-\s]?прес)\.?$/i, place: /sof[ií]j?a|софия/i, country: ['bu'], years: [1965, 1990],
    allowNoPlace: true,
  },
  {
    id: 'foreign-languages-publishing-house-bucharest',
    search: [],
    match: FLPH, place: /bucure[sș]ti|bucharest|bukarest|bucarest/i, country: ['rm'], years: [1945, 1995],
  },
  {
    id: 'peoples-publishing-house-lahore',
    search: [],
    match: /^people'?s\s+pub(lishing|l?\.)?\s*house(\s+(pvt\.?\s+)?ltd\.?)?\.?$/i, place: /lahore/i, country: ['pk'], years: [1942, 2030],
  },

  // --- Chinese Communist Party presses (Chinese-language; people's presses to 1990) --
  {
    id: 'shanghai-peoples-publishing-house',
    search: ['Shanghai ren min chu ban she'],
    match: /^((shanghai|hua\s*dong)\s*)?ren\s*min\s*chu\s*ban\s*she\.?$|^上海人民出版社$|^shanghai\s+people'?s\s+pub\w*\s+house\.?$/i,
    place: /shanghai|上海/i, country: ['cc'], years: [1951, 1990],
  },
  {
    id: 'tianjin-peoples-publishing-house',
    search: ['Tianjin ren min chu ban she'],
    match: /^(tianjin\s*)?ren\s*min\s*chu\s*ban\s*she\.?$|^天津人民出版社$|^tianjin\s+people'?s\s+pub\w*\s+house\.?$/i,
    place: /tianjin|tientsin|天津/i, country: ['cc'], years: [1950, 1990],
  },
  {
    id: 'study-press',
    search: ['Xue xi chu ban she'],
    match: /^(xue\s*xi\s*chu\s*ban\s*she|学习出版社|study\s+press)\.?$/i, place: PEKING, country: ['cc'], years: [1993, 2030],
    allowNoPlace: true,
  },
  {
    id: 'central-party-literature-press',
    search: ['Zhong yang wen xian chu ban she', 'Central Party Literature Press'],
    match: /^(zhong\s*yang\s*wen\s*xian\s*chu\s*ban\s*she|中央文献出版社|central\s+(party\s+)?literature\s+(press|publishing\s+house))\.?$/i,
    place: PEKING, country: ['cc'], years: [1987, 2030],
    allowNoPlace: true,
  },
  {
    id: 'party-building-books-publishing-house',
    search: ['Dang jian du wu chu ban she'],
    match: /^(dang\s*jian\s*du\s*wu\s*chu\s*ban\s*she|党建读物出版社|party\s+building\s+books\s+pub\w*\s+house)\.?$/i,
    place: PEKING, country: ['cc'], years: [1992, 2030], allowNoPlace: true,
  },

  // --- Soviet presses --------------------------------------------------------
  {
    // Partizdat (1931–41), Gospolitizdat (1941–63), Politizdat (1963–91).
    id: 'politizdat',
    search: ['Politizdat', 'Gospolitizdat', 'Izd-vo polit. lit-ry', 'Izd-vo politicheskoĭ literatury'],
    // Not the Ukrainian house, "Izd-vo polit. lit-ry Ukrainy" (CiNii records carry no place to tell them apart).
    match: /^(?!.*(ukrain|украин))(politizdat|gospolitizdat|partizdat|политиздат|госполитиздат|партиздат|(izd(-vo|\.|atel.stvo)\s+)?polit(\.|icheskoi|icheskoĭ|ičeskoj)\s*lit(\.|-ry|eratury)|изд(-во|ательство)\s+полит)/i,
    place: MOSCOW, country: ['ru', 'ur'], years: [1931, 1991],
    // Sofia had a Партиздат too; a Bulgarian book under the name is the Bulgarian party's (CiNii has no place).
    exclude: (t) => /^Bulgarian/.test(t.language),
  },
  {
    id: 'novosti-press-agency-publishing-house',
    search: ['Novosti Press Agency Publishing House', 'Novosti Press Agency Pub. House', 'Novosti'],
    match: /^(novosti(\s+press(\s+agency)?)?(\s+pub\w*\.?\s+house)?|(izd(-vo|\.)\s+)?agentstv[ao]\s+pechati\s+.?novosti.?|apn)\.?$/i,
    place: MOSCOW, country: ['ru', 'ur'], years: [1961, 1991],
  },
  {
    id: 'mir-publishers',
    search: ['Mir Publishers', 'Mir'],
    match: /^(mir(\s+pub\w*\.?)?|izd(-vo|\.)?\s+.?mir.?|мир)\.?$/i, place: MOSCOW, country: ['ru', 'ur'], years: [1964, 2012],
  },
  {
    id: 'raduga-publishers',
    search: ['Raduga Publishers', 'Raduga'],
    match: /^(raduga(\s+pub\w*\.?)?|izd(-vo|\.)?\s+.?raduga.?|радуга)\.?$/i, place: MOSCOW, country: ['ru', 'ur'], years: [1982, 2030],
  },

  // --- Soviet literary publishers (fiction, poetry, children's books) -----------
  {
    id: 'sovetskii-pisatel',
    search: ["Sovetskii pisatel", "Sovetskiĭ pisatelʹ", "Sov. pisatel"],
    match: /^[«"„]?((izd(atel\S*|-vo|\.)\s+)?[«"„]?sov(etsk\S*|\.)\s*pisatel\S*|советский\s+писатель)/i,
    place: /mosc|moskv|leningrad|l\.$/i, country: ['ru', 'ur'], years: [1934, 1992],
  },
  {
    id: 'khudozhestvennaia-literatura',
    search: ['Khudozhestvennaia literatura', 'Khudozh. lit-ra', 'Goslitizdat', 'Gos. izd-vo khudozh. lit-ry'],
    // Library of Congress "Khudozh.", ISO 9 (SUDOC) "Hudož.", and Cyrillic.
    match: /^[«"„]?((izd(atel\S*|-vo|\.)\s+)?[«"„]?k?hudo(zh|ž)(estvenn\S*|\.)\s*lit(eratur\S*|-r\S*|\.)|gos(udarstvennoe)?\.?\s*izd(atel\S*|-vo|\.)\s*k?hudo(zh|ž)\S*\s*lit\S*|goslitizdat\b|gikhl\b|художественная\s+литература|гослитиздат)/i,
    place: /mosc|moskv|leningrad|l\.$/i, country: ['ru', 'ur'], years: [1930, 1991],
  },
  {
    id: 'molodaia-gvardiia',
    search: ['Molodaia gvardiia', 'Mol. gvardiia', 'Molodaya gvardiya'],
    match: /^[«"„]?((izd(atel\S*|-vo|\.)\s+)?[«"„]?mol(oda\S*|\.)\s*gvard\S*|молодая\s+гвардия)/i,
    place: /mosc|moskv|leningrad|l\.$/i, country: ['ru', 'ur'], years: [1922, 1991],
  },
  {
    id: 'detskaia-literatura',
    search: ['Detskaia literatura', 'Detgiz', 'Detizdat'],
    match: /^[«"„]?((izd(atel\S*|-vo|\.)\s+)?[«"„]?detsk\S*\s*lit(eratur\S*|\.)|detgiz\b|detizdat\b|детская\s+литература|детгиз)/i,
    place: /mosc|moskv|leningrad|l\.$/i, country: ['ru', 'ur'], years: [1933, 1991],
  },

  // --- European party and New Left presses -----------------------------------
  {
    // East Berlin only; the SPD's J. H. W. Dietz Nachf. (Stuttgart, Bonn, West Berlin) is a different house.
    id: 'dietz-verlag',
    search: ['Dietz Verlag', 'Dietz'],
    match: /^((karl\s+)?dietz(\s+verlag)?(\s+berlin)?|j\.?\s*h\.?\s*w\.?\s*dietz\s+nachf(olger|\.)?(\s+gmbh)?)\.?$/i,
    place: /^(?!.*(bonn|stuttgart|hannover|hanover|west)).*berlin/i, country: ['ge'], years: [1946, 2030],
  },
  {
    id: 'editions-sociales',
    search: ['Éditions sociales', 'Editions sociales', 'Éditions sociales internationales'],
    match: /^((les\s+)?[ée]ditions\s+sociales(\s+internationales)?|[ée]d(itions|\.)\s+sociales|messidor\s*\/?\s*[ée]ditions\s+sociales)\.?$/i,
    place: /paris/i, country: ['fr'], years: [1927, 2030], allowNoPlace: true,
  },
  {
    id: 'pluto-press',
    search: ['Pluto Press'],
    match: /^pluto(\s+press)?(\s+ltd\.?)?\.?$/i, place: /london|sterling|ann\s+arbor|virginia|michigan/i,
    country: ['enk', 'xxk'], years: [1969, 2030], allowNoPlace: true,
  },
  {
    id: 'zed-books',
    search: ['Zed Books', 'Zed Press'],
    match: /^zed(\s+(books|press))?(\s+(ltd|limited)\.?)?\.?$/i, place: /london|new\s*jersey|atlantic\s+highlands|new\s*york/i,
    country: ['enk', 'xxk'], years: [1977, 2030], allowNoPlace: true,
  },
  {
    id: 'merlin-press',
    search: ['Merlin Press'],
    match: /^(the\s+)?merlin(\s+press)?(\s+(ltd|limited)\.?)?\.?$/i, place: /london|pontypool|monmouth|wales|dagenham/i,
    country: ['enk', 'xxk', 'wlk'], years: [1956, 2030],
  },

  // --- Albanian state presses -------------------------------------------------
  {
    id: 'naim-frasheri',
    search: ['Naim Frashëri', 'Naim Frasheri'],
    match: /^(sht(ëpia|epia)?\.?\s*b(otuese)?\.?\s*)?[«"„]?(n(aim)?\.?\s*)?frash[eë]ri[»"“]?(\s+pub\w*\s+house)?\.?$/i,
    place: /tiran[aëe]/i, country: ['aa'], years: [1946, 1991],
  },
  {
    id: '8-nentori',
    search: ['8 Nëntori', '8 Nentori'],
    match: /^(sht(ëpia|epia)?\.?\s*b(otuese)?\.?\s*)?[«"„]?8\s*n[eë]ntori[»"“]?(\s+pub\w*\s+house)?\.?$/i,
    place: /tiran[aëe]/i, country: ['aa'], years: [1973, 1991],
  },

  // --- Pro-Albanian (Hoxhaist) party presses -----------------------------------
  {
    id: 'norman-bethune-institute',
    search: ['Norman Bethune Institute', 'Institut Norman Bethune'],
    match: /^(published\s+by\s+)?(the\s+)?(norman\s+bethune\s+institute|institut\s+norman\s+bethune)\b/i,
    place: /toronto|montr[eé]al|canada/i, country: ['onc', 'quc', 'xxc'], years: [1970, 2000],
    allowNoPlace: true,
  },
  {
    id: 'verlag-roter-morgen',
    search: ['Roter Morgen'],
    match: /^((zeitungs)?verl(ag|\.)?\s+)?roter\s+morgen\b/i,
    place: /dortmund|hamburg|gelsenkirchen/i, country: ['gw'], years: [1969, 1986],
    allowNoPlace: true,
  },

  // --- Early socialist and communist presses ---------------------------------
  {
    id: 'emancipation-of-labour-group',
    // Pre-reform transliterations such as Gruppa "Osvobozhdenīe truda", Zheneva.
    search: ['Osvobozhdenie truda', 'Gruppa Osvobozhdenie truda'],
    match: /osvobo(zh|ž)den\S*\s+truda|освобожден\S*\s+труда/i,
    place: /gen[eè]v|zhenev|женев/i, country: ['sz'], years: [1883, 1903],
  },
  {
    id: 'iskra-press',
    search: ['Iskra'],
    match: /^(tip(ografiia|\.)\s+)?[«"„]?iskr[ayi][»"“]?\.?$|искр/i,
    place: /m[uü]nch|london|gen[eè]v|zhenev|женев/i, country: ['gw', 'enk', 'sz'], years: [1900, 1905],
  },
  {
    id: 'twentieth-century-press',
    search: ['Twentieth Century Press'],
    match: /^(the\s+)?twentieth\s+century\s+press(\s+(ltd|limited)\.?)?\.?$/i,
    place: /london/i, country: ['enk', 'xxk'], years: [1891, 1922],
  },
  {
    id: 'new-york-labor-news-company',
    search: ['New York Labor News'],
    match: /^new\s+york\s+labor\s+news(\s+co(mpany|\.)?)?\.?$/i,
    place: /new\s*york|brooklyn|palo\s+alto|mountain\s+view/i, country: ['nyu', 'cau', 'xxu'], years: [1889, 1995],
    allowNoPlace: true,
  },
  {
    id: 'workers-age-publishers',
    search: ['Workers Age'],
    match: /^workers'?\s*age(\s+pub(\.|lishers|lishing)?(\s+(association|ass'?n|assoc|assn)\.?)?)?\.?$/i,
    place: NEW_YORK, country: ['nyu'], years: [1929, 1941],
    allowNoPlace: true,
  },
  {
    id: 'socialist-labour-press',
    search: ['Socialist Labour Press', 'Socialist Labor Press'],
    match: /^socialist\s+labou?r\s+press\.?$/i, place: /glasgow|edinburgh/i, country: ['stk', 'xxk'], years: [1903, 1980],
  },
  {
    id: 'carl-hoym-verlag',
    search: ['Carl Hoym', 'Verlag der Kommunistischen Internationale'],
    match: /^(verlag\s+)?(carl\s+)?hoym\b|^verlag\s+der\s+kommunistischen\s+internationale/i,
    place: /hamburg|berlin/i, country: ['gw'], years: [1920, 1933],
  },
  {
    // The KPD's house traded as VIVA, Agis-Verlag and Internationaler Arbeiterverlag.
    id: 'viva',
    search: ['Vereinigung Internationaler Verlagsanstalten', 'Agis-Verlag', 'Internationaler Arbeiterverlag'],
    match: /^(viva\b|v\.\s*i\.\s*v\.\s*a\.?|vereinigung\s+internationaler\s+verlags[-\s]?anstalten|agis[-\s]?verlag|internationaler\s+arbeiter[-\s]?verlag)/i,
    place: /berlin/i, country: ['gw'], years: [1919, 1933],
  },
  {
    id: 'verlag-fur-literatur-und-politik',
    search: ['Verlag für Literatur und Politik'],
    match: /^verl(ag|\.)?\s+f(ür|ur|\.)\s+lit(eratur|\.)?\s+u(nd|\.)?\s+pol(itik|\.)?\.?$/i,
    place: /wien|vienna|berlin/i, country: ['au', 'gw'], years: [1924, 1934],
  },
  {
    id: 'librairie-de-l-humanite',
    search: ["Librairie de l'Humanité"],
    match: /^(librairie\s+de\s+l'?\s*humanit[ée]|l'humanit[ée])\.?$/i, place: /paris/i, country: ['fr'], years: [1913, 1927],
  },
  {
    id: 'volksbuchhandlung-hottingen-zurich',
    // Its books were issued through the exile party's cooperative press.
    search: ['Volksbuchhandlung', 'Schweizerische Genossenschaftsbuchdruckerei'],
    match: /^(verlag\s+der\s+)?volksbuchhandlung|^(der\s+)?schweizerische[n]?\s+genossenschafts[-\s]*(buch)?druckerei/i,
    place: /z[uü]rich|hottingen/i, country: ['sz'], years: [1878, 1892],
  },
  {
    // The SPD's house; the SED's East Berlin Dietz Verlag (1946–) is matched first, above.
    id: 'jhw-dietz',
    yieldTo: ['dietz-verlag'],
    search: ['J.H.W. Dietz', 'J. H. W. Dietz Nachf.'],
    match: /^(verlag\s+(von\s+)?)?j\.?\s*h\.?\s*w\.?\s*dietz(\s+nachf(olger|\.)?)?(\s+gmbh)?\.?$/i,
    place: /stuttgart|berlin|bonn|hannover|hanover/i, country: ['gw'], years: [1881, 2030],
  },
  {
    id: 'buchhandlung-vorwarts',
    search: ['Buchhandlung Vorwärts', 'Vorwärts'],
    match: /^((buchhandlung|verlag)\s+(des\s+)?vorw[aä]rts|vorw[aä]rts(\s+buchhandlung|\s*-?\s*verlag)?|(verlag\s+der\s+)?expedition\s+(der\s+buchhandlung\s+|des\s+)?vorw[aä]rts)/i,
    place: /berlin/i, country: ['gw'], years: [1891, 1933],
  },
  {
    id: 'wiener-volksbuchhandlung',
    search: ['Wiener Volksbuchhandlung'],
    match: /^wiener\s+volksbuchhandlung/i, place: /wien|vienna/i, country: ['au'], years: [1894, 1934],
  },
  {
    id: 'critica-sociale',
    search: ['Critica sociale'],
    match: /^((ed(izioni|\.)|uffici)\s+(della\s+)?)?[«"„]?critica\s+sociale[»"“]?\.?$/i,
    place: /milan/i, country: ['it'], years: [1891, 2030], allowNoPlace: true,
  },
  {
    id: 'avanti',
    search: ['Avanti!', 'Edizioni Avanti'],
    match: /^((ed(izioni|\.)|societ[aà]\s+editrice)\s+(dell'?\s*)?)?[«"„]?avanti!?[»"“]?\.?$/i,
    place: /roma|rome|milan/i, country: ['it'], years: [1896, 1993],
  },

  // --- Philippines -------------------------------------------------------------
  {
    id: 'pulang-tala-publications',
    search: ['Pulang Tala', 'Lathalaang Pulang Tala'],
    match: /^(lathalaang\s+)?pulang\s+tala(\s+pub\w*)?\.?$/i, place: /philippin|manila|luzon|quezon/i, country: ['ph'], years: [1969, 1973],
    allowNoPlace: true,
  },
  {
    id: 'international-network-for-philippine-studies',
    search: ['International Network for Philippine Studies'],
    match: /^(stichting\s+)?(inps|international\s+network\s+for\s+philippine\s+studies)\b/i,
    place: /utrecht|netherlands|quezon|manila|philippin/i, country: ['ne', 'ph'], years: [1989, 2030], allowNoPlace: true,
  },
  {
    id: 'foundation-for-nationalist-studies',
    search: ['Foundation for Nationalist Studies'],
    match: /^(the\s+)?(foundation\s+for\s+nationalist\s+studies|constantino\s+foundation)(,?\s+inc\.?)?\.?$/i,
    place: /quezon|manila|philippin/i, country: ['ph'], years: [1976, 2030], allowNoPlace: true,
  },
  {
    id: 'ibon-foundation',
    search: ['IBON'],
    match: /^ibon(\s+(foundation|databank|books|philippines))*(,?\s+inc\.?)?\.?$/i,
    place: /quezon|manila|philippin/i, country: ['ph'], years: [1978, 2030], allowNoPlace: true,
  },

  // --- Africa and African exile presses -------------------------------------------
  {
    id: 'tanzania-publishing-house',
    search: ['Tanzania Publishing House'],
    match: /^tanzania\s+pub(lishing|l?\.)?\s*house(\s+ltd\.?)?\.?$/i, place: /dar\s*es\s*salaam|tanzania/i,
    country: ['tz'], years: [1966, 2030], allowNoPlace: true,
  },
  {
    id: 'inkululeko-publications',
    search: ['Inkululeko'],
    match: /^inkululeko(\s+pub\w*)?\.?$/i, place: /london/i, country: ['enk', 'xxk'], years: [1971, 1990], allowNoPlace: true,
  },
  {
    id: 'panaf-books',
    search: ['Panaf', 'Panaf Books'],
    match: /^panaf(\s+(books|publishing))?(\s+(ltd|limited)\.?)?\.?$/i, place: /london|conakry|bedford/i,
    country: ['enk', 'xxk'], years: [1968, 2030], allowNoPlace: true,
  },
  {
    id: 'frelimo-information-department',
    search: ['FRELIMO', 'Frente de Libertação de Moçambique'],
    match: /^((partido\s+)?frelimo\b|frente\s+de\s+liberta\S+\s+de\s+mo\S+mbique)/i,
    // The Department of Information and Propaganda (1963–c. 1976), then FRELIMO's party publications.
    place: /maputo|louren[cç]o\s+marques|dar\s*es\s*salaam|mo[cç]ambique|mozambique/i, country: ['mz', 'tz'], years: [1963, 2030],
    allowNoPlace: true,
  },
  {
    id: 'ravan-press',
    search: ['Ravan Press'],
    match: /^ravan(\s+press)?(\s+\(pty\))?(\s+(ltd|limited)\.?)?\.?$/i,
    place: /johannesburg|braamfontein|randburg|cape\s+town|durban|south\s+africa/i, country: ['sa'], years: [1972, 1999],
    allowNoPlace: true,
  },
  {
    id: 'bogle-l-ouverture',
    search: ["Bogle-L'Ouverture", 'Bogle L Ouverture'],
    match: /^bogle[-\s]*l'?\s*ouverture(\s+(publications|press))?(\s+(ltd|limited)\.?)?\.?$/i, place: /london/i,
    country: ['enk', 'xxk'], years: [1969, 2030], allowNoPlace: true,
  },

  // --- Indian regional-language Marxist presses ------------------------------------
  {
    id: 'national-book-agency',
    search: ['National Book Agency'],
    match: /^national\s+book\s+agency(\s+(pvt\.?|private|\(p\)))?(\s+(ltd|limited)\.?)?\.?$/i,
    place: /calcutta|kolkata|kalik[aā]t[aā]/i, country: ['ii'], years: [1939, 2030],
  },
  {
    id: 'manisha-granthalaya',
    search: ['Manisha Granthalaya'],
    match: /^man[iī][sś][aā]\s+granth[aā]laya(\s+(pvt\.?|private|\(p\)))?(\s+(ltd|limited)\.?)?\.?$/i,
    place: /calcutta|kolkata|kalik[aā]t[aā]/i, country: ['ii'], years: [1964, 2030], allowNoPlace: true,
  },
  {
    id: 'chintha-publishers',
    search: ['Chintha Publishers', 'Chintha'],
    match: /^chint(h)?a(\s+(publishers|pub\w*))?\.?$/i, place: /trivandrum|thiruvananthapuram|tiruvanantapuram|kerala/i,
    country: ['ii'], years: [1973, 2030], allowNoPlace: true,
  },
  {
    id: 'prabhath-book-house',
    search: ['Prabhath Book House', 'Prabhat Book House'],
    match: /^prabh[aā]t(h)?\s+book\s+house\.?$/i, place: /trivandrum|thiruvananthapuram|tiruvanantapuram|kerala|kollam|quilon/i,
    country: ['ii'], years: [1952, 2030], allowNoPlace: true,
  },
  {
    id: 'new-century-book-house',
    search: ['New Century Book House'],
    match: /^(new\s+century\s+book\s+house(\s+(pvt\.?|private|\(p\)))?(\s+(ltd|limited)\.?)?|ncbh)\.?$/i,
    place: /madras|chennai|cenn[aā][iī]|tamil/i, country: ['ii'], years: [1951, 2030], allowNoPlace: true,
  },
  {
    id: 'visalaandhra-publishing-house',
    search: ['Visalaandhra Publishing House', 'Visalandhra Publishing House'],
    match: /^vi[sś][aā]l[aā]+ndhra\s+pub\w*\.?\s*house\.?$/i, place: /hyderabad|haidar[aā]b[aā]d|vijayawada|andhra/i,
    country: ['ii'], years: [1952, 2030], allowNoPlace: true,
  },
  {
    id: 'prajasakti-book-house',
    // Prajashakthi Publishing House (1940s), Marxist Pracharanalu (1960s), Prajasakti Book House (1977–).
    search: ['Prajasakti Book House', 'Prajashakti Book House', 'Prajashakthi Publishing House', 'Marxist Pracharanalu'],
    match: /^(praj[aā]\s*[sś]h?akt(h)?i\s+(book|pub\w*)\s+house|m[aā]rksisṭ?t?\s+pr[aā]c[h]?[aā]ra[nṇ][aā]lu)\.?$/i,
    place: /vijayawada|bezawada|hyderabad|haidar[aā]b[aā]d|hanumakonda|tirupati|andhra|telangana/i,
    country: ['ii'], years: [1942, 2030], allowNoPlace: true,
  },
  {
    // The People's Publishing House in Maharashtra; LC records use "Lokavāṅmaya Gr̥ha".
    id: 'lok-vangmay-griha',
    search: ['Lokavangmaya Grha', 'Lok Vangmay Griha', 'Lokvangmay Griha'],
    match: /^lok(a)?\s*-?\s*v[aā][nṅ]+[gm]\S*\s+g\S*h\S*(\s+(pvt\.?|private|\(p\)))?(\s+(ltd|limited)\.?)?\.?$/i,
    place: /bombay|mumbai|mu[mṃ]ba[iī]/i, country: ['ii'], years: [1950, 2030], allowNoPlace: true,
  },
  {
    id: 'navakarnataka-publications',
    search: ['Navakarnataka', 'Navakarnataka Publications'],
    match: /^nava\s*-?\s*karn[aā][tṭ]aka(\s+(publications|prak[aā][sś]ana))?(\s+(pvt\.?|private|\(p\)))?(\s+(ltd|limited)\.?)?\.?$/i,
    place: /bangalore|bengaluru|beṅgaḷūru|karnataka/i, country: ['ii'], years: [1960, 2030], allowNoPlace: true,
  },

  // --- Latin America -------------------------------------------------------------
  {
    id: 'editorial-anteo',
    search: ['Editorial Anteo', 'Anteo'],
    match: /^(editorial\s+)?anteo\.?$/i, place: /buenos\s+aires/i, country: ['ag'], years: [1942, 1988],
  },
  {
    id: 'editorial-cartago',
    search: ['Editorial Cartago', 'Cartago'],
    match: /^(editorial\s+|ediciones\s+)?cartago\.?$/i, place: /buenos\s+aires|m[eé]xico/i, country: ['ag', 'mx'], years: [1958, 1985],
  },
  {
    id: 'siglo-xxi-editores',
    search: ['Siglo XXI Editores', 'Siglo Veintiuno Editores', 'Siglo XXI de España'],
    match: /^siglo\s+(xxi|veintiuno)(\s+(editores|de\s+espa[nñ]a(\s+editores)?|argentina(\s+editores)?))?(,?\s*s\.?\s*a\.?(\s+de\s+c\.?\s*v\.?)?)?\.?$/i,
    place: /m[eé]xico|buenos\s+aires|madrid/i, country: ['mx', 'ag', 'sp'], years: [1965, 2030], allowNoPlace: true,
  },
  {
    id: 'editorial-de-ciencias-sociales',
    search: ['Editorial de Ciencias Sociales', 'Editorial Ciencias Sociales'],
    match: /^(editorial\s+(de\s+)?)?ciencias\s+sociales\.?$/i, place: /habana|havana|cuba/i, country: ['cu'], years: [1967, 2030],
  },
  {
    id: 'quimantu',
    search: ['Quimantú', 'Quimantu', 'Editora Nacional Quimantú'],
    match: /^((editora|empresa\s+editora)\s+(nacional\s+)?)?quimant[uú](\s+ltda\.?)?\.?$/i, place: /santiago|chile/i,
    country: ['cl'], years: [1971, 1973], allowNoPlace: true,
  },
  {
    id: 'editorial-vitoria',
    search: ['Editorial Vitória', 'Editorial Vitoria'],
    match: /^(editorial\s+)?vit[oó]ria(\s+(ltda|limitada)\.?)?\.?$/i, place: /rio\s+de\s+janeiro/i, country: ['bl'], years: [1944, 1964],
  },
  {
    id: 'expressao-popular',
    search: ['Expressão Popular', 'Expressao Popular'],
    match: /^(editora\s+)?express[aã]o\s+popular\.?$/i, place: /s[aã]o\s+paulo/i, country: ['bl'], years: [1999, 2030], allowNoPlace: true,
  },
  {
    id: 'ediciones-pueblos-unidos',
    search: ['Ediciones Pueblos Unidos', 'Pueblos Unidos'],
    match: /^((ediciones\s+)?pueblos\s+unidos|epu)\.?$/i, place: /montevideo/i, country: ['uy'], years: [1942, 1990],
  },
  {
    id: 'editorial-nueva-nicaragua',
    search: ['Editorial Nueva Nicaragua'],
    match: /^(editorial\s+)?nueva\s+nicaragua(\s*[-–,:]?\s*ediciones\s+monimb[oó])?\.?$/i, place: /managua|nicaragua/i,
    country: ['nq'], years: [1981, 1997], allowNoPlace: true,
  },

  // --- Southern and Western Europe -----------------------------------------------
  {
    id: 'editori-riuniti',
    search: ['Editori Riuniti', 'Edizioni Rinascita', 'Edizioni di Cultura Sociale'],
    match: /^(editori\s+riuniti|edizioni\s+(rinascita|di\s+cultura\s+sociale))\.?$/i, place: /roma|rome|milano|milan/i,
    country: ['it'], years: [1944, 2030], allowNoPlace: true,
  },
  {
    id: 'feltrinelli',
    search: ['Feltrinelli'],
    match: /^((giangiacomo\s+)?feltrinelli(\s+editore)?|g\.\s*feltrinelli)\.?$/i, place: /milan/i, country: ['it'], years: [1954, 1980],
    allowNoPlace: true,
  },
  {
    id: 'ediciones-europa-america',
    search: ['Ediciones Europa-América', 'Europa-América'],
    match: /^(ediciones\s+)?europa[-\s]*am[eé]rica\.?$/i, place: /madrid|barcelona|valencia/i, country: ['sp'], years: [1929, 1939],
  },
  {
    id: 'editorial-ebro',
    search: ['Editorial Ebro', 'Colección Ebro'],
    match: /^((editions\s+de\s+la\s+)?librairie\s+du\s+globe[\s,;–-]*)?((editorial|colecci[oó]n)\s+)?ebro\.?$/i, place: /paris|bucarest|bucure/i,
    country: ['fr', 'rm'], years: [1967, 1977],
  },
  {
    id: 'ediciones-akal',
    search: ['Ediciones Akal', 'Akal'],
    match: /^(ediciones\s+)?akal(\s+editor)?\.?$/i, place: /madrid|tres\s+cantos/i, country: ['sp'], years: [1972, 1990], allowNoPlace: true,
  },
  {
    id: 'synchroni-epochi',
    search: ['Synchronē Epochē', 'Synchroni Epochi', 'Sygchronē Epochē', 'Syghroni Epoxh', 'Σύγχρονη Εποχή'],
    // Library romanisations vary: Synchronē Epochē, Sygchronē Epochē, Syghroni Epoxh.
    match: /^((ekdoseis|εκδόσεις)\s+)?(s[yi][ng]?[ck]?h?ron[eēiη]\s+epo(ch|x|χ)h?[eēi]?|σύγχρονη\s+εποχή)\.?$/i,
    place: /ath[eē]na|athens|αθήνα/i, country: ['gr'], years: [1972, 2030], allowNoPlace: true,
  },
  {
    id: 'edicoes-avante',
    search: ['Edições Avante', 'Editorial Avante'],
    // Legal from 1974; the imprint was used underground earlier (a 1957 title is recorded).
    match: /^((edi[cç][oõ]es|editorial)\s+)?[«"„]?avante!?[»"“]?\.?$/i, place: /lisboa|lisbon/i, country: ['po'], years: [1931, 2030],
    allowNoPlace: true,
  },
  {
    // Éditions François Maspero (1959–1982), then Éditions La Découverte.
    id: 'editions-maspero',
    search: ['Maspero', 'François Maspero', 'La Découverte'],
    match: /^((éditions|editions|librairie)\s+)?(fran[cç]ois\s+)?maspero\.?$|^((éditions|editions)\s+)?la\s+d[ée]couverte\.?$/i,
    place: /paris/i, country: ['fr'], years: [1959, 1982], allowNoPlace: true,
  },

  // --- Laos ----------------------------------------------------------------------
  {
    id: 'neo-lao-haksat-publications',
    search: ['Neo Lao Haksat', 'Éditions du Neo Lao Haksat'],
    match: /^((é|e)ditions\s+du\s+)?neo\s+lao\s+ha[kc]\s*sat(\s+pub\w*)?\.?$/i, place: /laos|sam\s*neua|vientiane|hanoi/i, country: ['ls'], years: [1964, 1975],
    allowNoPlace: true,
  },

  // --- Presses of smaller and defeated communist movements ---------------------
  {
    id: 'jajasan-pembaruan',
    search: ['Jajasan Pembaruan', 'Yayasan Pembaruan'],
    match: /^(j|y)ajasan\s+[«"„]?pembaruan[»"“]?\.?$|^pembaruan\.?$/i,
    place: /dj?akarta|jakarta|indonesia/i, country: ['io'], years: [1950, 1966],
    allowNoPlace: true,
  },
  {
    id: 'depagitprop-pki',
    search: ['Depagitprop', 'Comite Central, Partai Komunis Indonesia'],
    match: /^depagitprop\s*(cc|c\.c\.)?\s*pki\.?$|(comite|central)\s+(central|comite),?\s+partai\s+komunis\s+indonesia|departemen\s+agitprop,?\s+(central\s+comite|c\.?c\.?)/i,
    place: /dj?akarta|jakarta|indonesia/i, country: ['io'], years: [1950, 1966],
    allowNoPlace: true,
  },
  {
    id: 'shin-nihon-shuppansha',
    search: ['Shin Nihon Shuppansha', 'Shin Nihon Shuppan'],
    match: /^(shin\s*nihon\s*shuppansha|新日本出版社)\.?$/i,
    place: /t[oō]ky[oō]|東京/i, country: ['ja'], years: [1957, 2030],
    allowNoPlace: true,
  },
  {
    id: 'progress-books',
    search: ['Progress Books'],
    match: /^progress\s+books\.?$/i,
    place: /toronto|canada/i, country: ['onc', 'xxc'], years: [1940, 2000],
  },
  {
    id: 'current-book-distributors',
    search: ['Current Book Distributors'],
    match: /^current\s+book\s+distributors\.?$/i,
    place: /sydney|australia/i, country: ['at', 'xna'], years: [1938, 1975],
    allowNoPlace: true,
  },
  {
    id: 'kuraz-publishing-agency',
    search: ['Kuraz', 'Kurāz'],
    match: /^kur(a|ā)z(\s+(pub\w*\s+agency|[aā]s[aā]t[aā]m[iī]\s+\S+))?\]?\.?$/i,
    place: /addis|ethiopia|ʼādis|ādis/i, country: ['et'], years: [1974, 1995],
    allowNoPlace: true,
  },
  {
    id: 'sol-yayinlari',
    search: ['Sol Yayınları', 'Sol Yayinlari'],
    match: /^sol\s+yay(ı|i)nlar(ı|i)\]?\.?$/i,
    place: /ankara|istanbul|t(ü|u)rk/i, country: ['tu'], years: [1965, 2030],
    allowNoPlace: true,
  },
  {
    id: 'kansankulttuuri',
    search: ['Kansankulttuuri'],
    match: /^kansankulttuuri(\s+oy)?\.?$/i,
    place: /helsin/i, country: ['fi'], years: [1944, 1986],
    allowNoPlace: true,
  },
  {
    id: 'tudeh-publishing-centre',
    search: ['Tudeh', 'Intishārāt-i Tūdah', 'Tudeh Verlag'],
    match: /^(tudeh\s+(verlag|pub(\.|lishing)?\s*cent(re|er))|intish[aā]r[aā]t-i\s+t[uū]dah|انتشارات توده)\.?$/i,
    place: /stockholm|sweden|sta(ss|ß)furt|leipzig|germany|deutschland|ddr/i, country: ['sw', 'ge', 'gw'], years: [1957, 1991],
    allowNoPlace: true,
  },
  {
    id: 'communist-party-of-great-britain',
    search: ['Communist Party of Great Britain'],
    match: /^(the\s+)?communist\s+party\s+(of\s+)?(gt\.?|great)\s+britain\.?$/i,
    place: /london|king\s+street/i, country: ['enk', 'xxk'], years: [1920, 1991],
    allowNoPlace: true,
  },
  {
    id: 'workers-library-publishers',
    search: ['Workers Library Publishers', "Workers' Library Publishers", 'Workers Library'],
    match: /^workers'?\s+library(\s+pub(lishers|\.)?)?(,?\s+inc\.?)?\.?$/i,
    place: NEW_YORK, country: ['nyu'], years: [1927, 1945],
    allowNoPlace: true,
  },
  {
    id: 'new-century-publishers',
    search: ['New Century Publishers'],
    match: /^new\s+century\s+pub(lishers|\.)(,?\s+inc\.?)?\.?$/i,
    place: NEW_YORK, country: ['nyu'], years: [1945, 1963],
  },
  {
    id: 'ediciones-de-cultura-popular',
    search: ['Ediciones de Cultura Popular', 'Fondo de Cultura Popular'],
    match: /^(ediciones|fondo)\s+de\s+cultura\s+popular\.?$/i,
    place: /m(é|e)xico/i, country: ['mx'], years: [1941, 1995],
    allowNoPlace: true,
  },
  {
    id: 'new-books-publications',
    search: ['New Books Publications'],
    match: /^new\s+books(\s+pub(lications|\.))?\.?$/i,
    place: /dublin|ireland/i, country: ['ie'], years: [1945, 1995],
  },

  // --- Further party, exile, Trotskyist and Maoist presses --------------------
  {
    id: 'su-that',
    search: ['Sự thật', 'Su that'],
    match: /^(nh\S*\s+xu\S*\s+b\S*n\s+)?s\S{1,3}\s+th\S{1,4}t\.?$/i,
    place: /h\S{0,3}\s*-?\s*n\S{0,3}i|hanoi|vi\S{0,2}t/i, country: ['vm'], years: [1945, 1992],
    allowNoPlace: true,
  },
  {
    id: 'jiefang-she',
    search: ['Jie fang she', 'Chieh fang she'],
    match: /^(jie\s*fang\s*she|chieh\s*fang\s*she|解放社)\.?$/i,
    place: /yan.?an|yenan|china|beijing|peking|zhangjiakou|jin|shan/i, country: ['cc'], years: [1937, 1950],
    allowNoPlace: true,
  },
  {
    id: 'xin-qing-nian-she',
    search: ['Xin qing nian she'],
    match: /^(fa\s*xing\s*zhe\s+)?(xin\s*qing\s*nian\s*she|新青年社)/i,
    place: /shanghai|guangzhou|canton|china/i, country: ['cc'], years: [1915, 1930],
    allowNoPlace: true,
  },
  {
    id: 'kibokaku',
    search: ['Kibōkaku', 'Kibokaku'],
    match: /^(kib[oō]kaku|希望閣)\.?$/i,
    place: /t[oō]ky[oō]|東京/i, country: ['ja'], years: [1920, 1945],
    allowNoPlace: true,
  },
  {
    id: 'kyoseikaku',
    search: ['Kyōseikaku', 'Kyoseikaku'],
    match: /^(ky[oō]seikaku|共生閣)\.?$/i,
    place: /t[oō]ky[oō]|ky[oō]to|東京/i, country: ['ja'], years: [1920, 1945],
    allowNoPlace: true,
  },
  {
    id: 'marukusu-shobo',
    search: ['Marukusu Shobō', 'Marukusu Shobo'],
    match: /^(marukusu\s*shob[oō]|マルクス書房)\.?$/i,
    place: /t[oō]ky[oō]|東京/i, country: ['ja'], years: [1920, 1945],
    allowNoPlace: true,
  },
  {
    id: 'hakuyosha',
    search: ['Hakuyōsha', 'Hakuyosha'],
    match: /^(hakuy[oō][-\s]?sha|白揚社)\.?$/i,
    place: /t[oō]ky[oō]|東京/i, country: ['ja'], years: [1920, 1945],
  },
  {
    id: 'malik-verlag',
    search: ['Malik-Verlag', 'Malik Verlag'],
    match: /^(der\s+)?malik([-\s]?verlag)?\.?$/i,
    place: /berlin|prag|praha|prague|london|wien/i, country: ['gw', 'xr', 'enk', 'au'], years: [1917, 1947],
  },
  {
    id: 'cooperative-publishing-society-of-foreign-workers',
    search: ['Co-operative Publishing Society of Foreign Workers', 'Verlagsgenossenschaft ausländischer Arbeiter', 'Towarzystwo Wydawnicze Robotników Zagranicznych'],
    match: /^(co-?operative\s+pub\w*\s+society\s+of\s+foreign\s+workers|verlagsgenossenschaft\s+ausl(ä|a)ndischer\s+arbeiter|vegaar\b|tow(arzystwo|\.)\s+wydaw(nicze|\.)\s+robotnik[óo]w\s+zagranicznych)/i,
    place: /mosc|moskv|moskau|leningrad/i, country: ['ru', 'ur'], years: [1930, 1939],
  },
  {
    id: 'dar-al-farabi',
    search: ['Dar al-Farabi', 'Dār al-Fārābī'],
    match: /^(d[aā]r\s+al[-\s]?f[aā]r[aā]b[iī]|دار الفارابي)\.?$/i,
    place: /bay?r[uū]t|beirut|beyrouth|lebanon|liban/i, country: ['le'], years: [1956, 2030],
    allowNoPlace: true,
  },
  {
    id: 'politikes-kai-logotechnikes-ekdoseis',
    search: ['Politikes kai Logotechnikes Ekdoseis'],
    match: /^(politik(e|ē)s\s+kai\s+logotechnik(e|ē)s\s+ekdos(e|ē)(i|ī)s|πολιτικ(έ|ε)ς\s+και\s+λογοτεχνικ(έ|ε)ς\s+εκδ(ό|ο)σεις)\.?$/i,
    place: /./, country: ['rm', 'gr', 'cy'], years: [1954, 1968],
    allowNoPlace: true,
  },
  {
    id: 'editora-austral',
    search: ['Editora Austral'],
    match: /^\[?editora\s+austral\]?\.?$/i,
    place: /santiago|chile/i, country: ['cl'], years: [1945, 1973],
    allowNoPlace: true,
  },
  {
    id: 'lanka-sama-samaja-party',
    search: ['Lanka Sama Samaja'],
    match: /^lanka\s+sama\s+samaja(\s+party)?(\s+pub\w*)?\.?$/i,
    place: /colombo|ceylon|maradana|sri\s*lanka/i, country: ['ce'], years: [1935, 2030],
    allowNoPlace: true,
  },
  {
    id: 'communist-party-of-new-zealand',
    search: ['Communist Party of New Zealand'],
    match: /^communist\s+party\s+of\s+new\s+zealand\.?$/i,
    place: /auckland|wellington|new\s+zealand/i, country: ['nz'], years: [1921, 1994],
    allowNoPlace: true,
  },
  {
    id: 'verlag-marxistische-blatter',
    search: ['Verlag Marxistische Blätter', 'Marxistische Blätter'],
    match: /^(verlag\s+)?marxistische\s+bl(ä|a)tter\.?$/i,
    place: /frankfurt|essen|d(ü|u)sseldorf|germany/i, country: ['gw'], years: [1963, 1995],
    allowNoPlace: true,
  },
  {
    id: 'pahl-rugenstein',
    search: ['Pahl-Rugenstein'],
    match: /^pahl[-\s]?rugenstein(\s+verlag)?\.?$/i,
    place: /k(ö|o)ln|cologne/i, country: ['gw'], years: [1957, 1989],
  },
  {
    id: 'verlag-neuer-weg',
    search: ['Verlag Neuer Weg'],
    match: /^(vnw\s*-\s*)?verlag\s+neuer\s+weg(\s*gmbh)?\.?$/i,
    place: /stuttgart|essen|gelsenkirchen|d(ü|u)sseldorf|germany/i, country: ['gw'], years: [1969, 2030],
    allowNoPlace: true,
  },
  {
    id: 'bureau-d-editions',
    search: ["Bureau d'éditions"],
    match: /^bureau\s+d'?\s*[ée]ditions?(,?\s+de\s+diffusion\s+et\s+de\s+publicit[ée])?\.?$/i,
    place: /paris/i, country: ['fr'], years: [1926, 1939],
  },
  {
    id: 'editions-du-centenaire',
    search: ['Éditions du Centenaire', 'Editions du Centenaire'],
    match: /^([ée]ditions?\s+du\s+)?centenaire\.?$/i,
    place: /paris/i, country: ['fr'], years: [1968, 1985],
  },
  {
    id: 'new-park-publications',
    search: ['New Park Publications'],
    match: /^new\s+park(\s+pub(lications|\.))?(\s+ltd\.?)?\.?$/i,
    place: /london/i, country: ['enk', 'xxk'], years: [1955, 1986],
    allowNoPlace: true,
  },
  {
    id: 'bookmarks',
    search: ['Bookmarks'],
    match: /^bookmarks(\s+pub(lications|\.))?(\s+ltd\.?)?\.?$/i,
    place: /london/i, country: ['enk', 'xxk'], years: [1979, 2030],
  },
  {
    id: 'liberator-press',
    search: ['Liberator Press'],
    match: /^liberator\s+press\.?$/i,
    place: /chicago/i, country: ['ilu'], years: [1973, 1982],
  },
  {
    id: 'rcp-publications',
    // The Revolutionary Union (1968–1975) published the Red Papers before it became the RCP.
    search: ['RCP Publications', 'Revolutionary Union'],
    match: /^(rcp\s+pub(lications|\.)|revolutionary\s+union)\.?$/i,
    place: /chicago|new\s+york|berkeley|san\s+francisco|united\s+states/i, country: ['ilu', 'nyu', 'cau'], years: [1968, 2030],
    allowNoPlace: true,
  },
  {
    id: 'labor-research-association',
    search: ['Labor Research Association'],
    match: /^labor\s+research\s+associat(ion|es)(,?\s+inc\.?)?\.?$/i,
    place: /new\s+york/i, country: ['nyu'], years: [1927, 2000],
    allowNoPlace: true,
  },
  {
    id: 'monad-press',
    search: ['Monad Press'],
    match: /^monad\s+press\.?$/i,
    place: /new\s+york/i, country: ['nyu'], years: [1970, 1995],
    allowNoPlace: true,
  },
  {
    id: 'red-star-publishers',
    search: ['Red Star Publishers'],
    match: /^red\s+star\s+publishers\.?$/i,
    place: /san\s+francisco|california|united\s+states|brooklyn|new\s+york/i, country: ['cau', 'nyu'], years: [2005, 2030],
  },
  {
    id: 'liberation-support-movement',
    search: ['LSM Information Center', 'Liberation Support Movement', 'LSM Press'],
    match: /^(lsm(\s+information\s+cent(er|re)|\s+press)?|liberation\s+support\s+movement(\s+information\s+cent(er|re))?)\.?$/i,
    place: /richmond|oakland|seattle|chicago|canada|b\.?\s*c\.?/i, country: ['bcc', 'cau', 'wau', 'ilu'], years: [1968, 1985],
    allowNoPlace: true,
  },
  {
    id: 'china-books-and-periodicals',
    search: ['China Books & Periodicals', 'China Books and Periodicals'],
    match: /^china\s+books\s*(&|and)\s*periodicals(,?\s+inc\.?)?\.?$/i,
    place: /san\s+francisco|new\s+york|chicago|california/i, country: ['cau', 'nyu', 'ilu'], years: [1960, 2030],
  },
  {
    id: 'progressive-labor-party',
    search: ['Progressive Labor Party', 'Progressive Labor'],
    match: /^progressive\s+labor(\s+party)?\.?$/i,
    place: /new\s+york|brooklyn/i, country: ['nyu'], years: [1962, 2030],
    allowNoPlace: true,
  },
  {
    id: 'arbetarkultur',
    search: ['Arbetarkultur'],
    match: /^\[?arbetarkultur(\[?s\s+f(ö|o)rlag\]?)?\]?\.?$/i,
    place: /stockholm/i, country: ['sw'], years: [1930, 1995],
    allowNoPlace: true,
  },
  {
    id: 'forlaget-oktober',
    search: ['Forlaget Oktober', 'Oktober'],
    match: /^(forlaget\s+)?oktober(\s+forlag)?\.?$/i,
    place: /oslo/i, country: ['no'], years: [1970, 1991],
  },
  {
    id: 'pegasus-amsterdam',
    search: ['Pegasus'],
    match: /^(uitgeverij\s+)?pegasus\.?$/i,
    place: /amsterdam|rotterdam/i, country: ['ne'], years: [1934, 1991],
  },
  {
    id: 'epo',
    search: ['EPO', 'Uitgeverij EPO'],
    match: /^((uitgeverij|[ée]ditions)\s+)?epo(\s+uitgeverij)?\.?$/i,
    place: /antwerp|anvers|berchem|brussel|bruxelles|belgi/i, country: ['be'], years: [1973, 2030],
  },
  {
    id: 'globus-verlag',
    search: ['Globus Verlag', 'Globus-Verlag'],
    match: /^globus[-\s]?verlag\.?$/i,
    place: /wien|vienna/i, country: ['au'], years: [1945, 1995],
  },

  // --- Presses of further countries ------------------------------------------
  {
    id: 'ksiazka-i-wiedza',
    search: ['Książka i Wiedza', 'Ksiazka i Wiedza'],
    match: /^((sp[óo]łdzielnia|sp[óo]ldzielnia)\s+wydawnicz\S*\s+)?["„]?ksi(ą|a)(ż|z)ka\s+i\s+wiedza["”]?\.?$/i,
    place: /warszaw|warsaw/i, country: ['pl'], years: [1948, 1990],
  },
  {
    id: 'svoboda',
    search: ['Svoboda', 'Nakladatelství politické literatury', 'Státní nakladatelství politické literatury'],
    match: /^\[?(nakladatelstv[ií]\s+)?svoboda\]?\.?$|^(st[áa]tn[ií]\s+)?nakladatelstv[ií]\s+politick[ée]\s+literatury\.?$|^snpl\.?$/i,
    place: /praha|prague|prag/i, country: ['xr', 'cs'], years: [1945, 1992],
  },
  {
    id: 'pravda-bratislava',
    search: ['Pravda', 'Slovenské vydavateľstvo politickej literatúry', 'Epocha'],
    match: /^(vydavate[lľ]stvo\s+)?pravda\.?$|^slovensk[ée]\s+vydavate[lľ]stvo\s+politickej\s+literat[úu]ry\.?$|^epocha\.?$/i,
    place: /bratislava/i, country: ['xo', 'cs'], years: [1953, 1990],
  },
  {
    id: 'komunist',
    search: ['Komunist', 'Izdavački centar Komunist'],
    match: /^(izdava[čc]ki\s+centar\s+)?["“]?komunist["”]?,?\.?$/i,
    place: /beograd|belgrade|ljubljana|zagreb|sarajevo|skopje|titograd|novi\s+sad|pri[šs]tina/i, country: ['yu', 'xv', 'ci', 'rb', 'bn', 'xn', 'mo'], years: [1945, 1991],
  },
  {
    id: 'forlaget-tiden',
    search: ['Forlaget Tiden'],
    match: /^(forlaget\s+)?tiden\.?$/i,
    place: /k[øo]benhavn|koebenhavn|kjøbenhavn|copenhagen/i, country: ['dk'], years: [1945, 1992],
  },
  {
    id: 'danmarks-kommunistiske-parti',
    search: ['Danmarks kommunistiske parti'],
    match: /^danmarks\s+kommunistiske\s+parti/i,
    place: /k[øo]benhavn|aarhus|århus|silkeborg|odense|aalborg|danmark/i, country: ['dk'], years: [1919, 1991],
    allowNoPlace: true,
  },
  {
    id: 'dar-al-hamdani',
    search: ['Dar al-Hamdani', 'Dār al-Hamdānī'],
    match: /^d[aā]r\s+al[-\s]?[hḥ]am[a]?d[aā]n[iī]\.?$/i,
    place: /aden|adan|yemen/i, country: ['ye', 'ys'], years: [1967, 1990],
    allowNoPlace: true,
  },
  {
    id: 'dar-al-thaqafa-al-jadida',
    search: ['Dār al-Thaqāfah al-Jadīdah', 'Dar al-Thaqafa al-Jadida'],
    match: /^d[aā]r\s+al[-\s]?thaq[aā]fa(h)?\s+al[-\s]?jad[iī]da(h)?\.?$|^دار الثقافة الجديدة$/i,
    place: /q[aā]hirah|cairo|caire|egypt|mi[sṣ]r/i, country: ['ua'], years: [1965, 2030],
    allowNoPlace: true,
  },
  {
    id: 'eplf',
    search: ["Eritrean People's Liberation Front"],
    match: /^eritrean\s+people'?s\s+liberation\s+front/i,
    place: /./, country: ['ea', 'et', 'it', 'sj', 'xxu', 'nyu'], years: [1970, 1994],
    allowNoPlace: true,
  },
  {
    id: 'uniao-dos-escritores-angolanos',
    search: ['União dos Escritores Angolanos'],
    match: /^uni[ãa]o\s+dos\s+escritores\s+angolanos/i,
    place: /luanda|angola/i, country: ['ao'], years: [1975, 1992],
    allowNoPlace: true,
  },
  {
    id: 'paigc',
    search: ['PAIGC'],
    match: /^\[?p\.?a\.?i\.?g\.?c\.?\??\]?\.?$|partido\s+africano\s+da\s+independ[êe]ncia\s+da\s+guin[ée]/i,
    place: /./, country: ['pg', 'cv', 'sg', 'gv'], years: [1956, 1991],
    allowNoPlace: true,
  },
  {
    id: 'empresa-editora-amauta',
    search: ['Empresa Editora Amauta', 'Biblioteca Amauta'],
    match: /^\[?((empresa\s+editora|biblioteca)\s+)?["“]?amauta["”]?\]?\.?$/i,
    place: /lima|per[uú]/i, country: ['pe'], years: [1926, 2030],
  },
  {
    id: 'ediciones-masas',
    search: ['Ediciones Masas'],
    match: /^ediciones\s+["“]?masas["”]?,?\.?$/i,
    place: /la\s+paz|bolivia/i, country: ['bo'], years: [1952, 2030],
    allowNoPlace: true,
  },
  {
    id: 'la-oveja-negra',
    search: ['La Oveja Negra', 'Oveja Negra'],
    match: /^(editorial\s+)?(la\s+)?oveja\s+negra\.?$/i,
    place: /medell[ií]n|bogot[áa]|colombia/i, country: ['ck'], years: [1968, 1979],
  },
  {
    id: 'partido-comunista-del-ecuador',
    search: ['Partido Comunista del Ecuador'],
    match: /partido\s+comunista\s+del\s+ecuador/i,
    place: /quito|guayaquil|ecuador/i, country: ['ec'], years: [1926, 2030],
    allowNoPlace: true,
  },
  {
    id: 'parti-unifie-des-communistes-haitiens',
    search: ['Parti unifié des communistes haïtiens'],
    match: /parti\s+unifi[ée]\s+des\s+communistes\s+ha[ïi]tiens/i,
    place: /./, country: ['ht', 'fr', 'xxu', 'nyu', 'quc'], years: [1968, 1991],
    allowNoPlace: true,
  },
  {
    id: 'akfm',
    search: ['AKFM', 'A.K.F.M.'],
    match: /^a\.?\s*k\.?\s*f\.?\s*m\.?(-kdrsm)?\.?$|antokon.?\s*ny\s+kongresin/i,
    place: /antananarivo|tananarive|madagas/i, country: ['mg'], years: [1958, 2030],
    allowNoPlace: true,
  },
  {
    id: 'communist-party-of-nepal',
    search: ['Communist Party of Nepal'],
    match: /communist\s+party\s+of\s+nepal/i,
    place: /kathmandu|nepal/i, country: ['np'], years: [1949, 2030],
    allowNoPlace: true,
  },
  {
    id: 'burma-socialist-programme-party',
    search: ['Burma Socialist Programme Party'],
    match: /burma\s+socialist\s+programme\s+party/i,
    place: /rangoon|yangon|burma|myanmar/i, country: ['br'], years: [1962, 1988],
    allowNoPlace: true,
  },
  {
    id: 'democratic-kampuchea',
    search: ['Democratic Kampuchea'],
    match: /democratic\s+kampuchea/i,
    place: /./, country: ['cb', 'th', 'xxu', 'nyu'], years: [1975, 1993],
    allowNoPlace: true,
  },
  {
    id: 'ulsyn-khevleliin-gazar',
    search: ['Ulsyn khėvlėliĭn gazar', 'Ulsyn Khevleliin Gazar', 'Ulsyn Hevleliin Gazar'],
    match: /^\[?ulsyn\s+k?h[eė]vl[eė]li[iĭ]{1,2}n\s+gazar\]?\.?$|^улсын\s+хэвлэлийн\s+газар$|^(gosizdat\s+mnr|госиздат\s+мнр)\.?$/i,
    place: /ula|ulan/i, country: ['mp'], years: [1921, 1990],
    allowNoPlace: true,
  },

  // --- Further parties of the Caribbean, Africa, Asia and the North Atlantic --
  {
    id: 'peoples-progressive-party',
    search: ["People's Progressive Party"],
    match: /people'?s\s+progressive\s+party/i,
    place: /georgetown|guyana|guiana|lacytown/i, country: ['gy'], years: [1950, 2030],
    allowNoPlace: true,
  },
  {
    id: 'working-peoples-alliance',
    search: ["Working People's Alliance"],
    match: /working\s+people'?s\s+alliance/i,
    place: /georgetown|guyana/i, country: ['gy'], years: [1974, 2030],
    allowNoPlace: true,
  },
  {
    id: 'fedon-publishers',
    search: ['Fedon Publishers'],
    match: /^fedon\s+pub(lishers|\.)/i,
    place: /grenada|st\.?\s*george/i, country: ['gd'], years: [1979, 1983],
    allowNoPlace: true,
  },
  {
    id: 'new-jewel-movement',
    search: ['New Jewel Movement'],
    match: /new\s+jewel\s+movement/i,
    place: /./, country: ['gd', 'enk', 'xxk'], years: [1973, 1995],
    allowNoPlace: true,
  },
  {
    id: 'workers-party-of-jamaica',
    search: ["Workers' Party of Jamaica", 'Workers Party of Jamaica'],
    match: /workers?'?\s+party\s+of\s+jamaica/i,
    place: /kingston|jamaica/i, country: ['jm'], years: [1974, 1992],
    allowNoPlace: true,
  },
  {
    id: 'parti-communiste-reunionnais',
    search: ['Parti communiste réunionnais'],
    match: /parti\s+communiste\s+r[ée]unionnais/i,
    place: /r[ée]union|saint-denis/i, country: ['re'], years: [1959, 2030],
    allowNoPlace: true,
  },
  {
    id: 'parti-communiste-guadeloupeen',
    search: ['Parti communiste guadeloupéen'],
    match: /parti\s+communiste\s+guadeloup[ée]en/i,
    place: /pointe|guadeloupe|basse-terre/i, country: ['gp'], years: [1944, 2030],
    allowNoPlace: true,
  },
  {
    id: 'parti-communiste-martiniquais',
    search: ['Parti communiste martiniquais'],
    match: /parti\s+communiste\s+martiniquais/i,
    place: /fort|martinique/i, country: ['mq'], years: [1957, 2030],
    allowNoPlace: true,
  },
  {
    id: 'meison',
    search: ['Meisone', 'MEISON'],
    match: /^me['ʼ]?is[oe]ne?\.?$|^meison\.?$/i,
    place: /./, country: ['et', 'fr', 'xx'], years: [1968, 1980],
    allowNoPlace: true,
  },
  {
    id: 'peoples-democratic-party-of-afghanistan',
    search: ["People's Democratic Party of Afghanistan"],
    match: /people'?s\s+democratic\s+party\s+of\s+afghanistan/i,
    place: /kabul|afghan/i, country: ['af'], years: [1965, 1992],
    allowNoPlace: true,
  },
  {
    id: 'akel',
    search: ['AKEL'],
    match: /^\[?a\.?k\.?e\.?l\.?\??\]?$/i,
    place: /nicosia|cyprus|lefko/i, country: ['cy'], years: [1926, 2030],
    allowNoPlace: true,
  },
  {
    id: 'mongolian-peoples-revolutionary-party',
    search: ["Mongolian People's Revolutionary Party"],
    match: /mongolian\s+people'?s\s+revolutionary\s+party/i,
    place: /ula/i, country: ['mp'], years: [1921, 2010],
    allowNoPlace: true,
  },
  {
    id: 'mal-og-menning',
    search: ['Mál og menning'],
    match: /^m[áa]l\s+og\s+menning(ar)?\.?$/i,
    place: /reykjav/i, country: ['ic'], years: [1937, 1990],
  },
  {
    id: 'heimskringla',
    search: ['Heimskringla'],
    match: /^(b[óo]ka[úu]tg[áa]fan\s+)?heimskringla\.?$/i,
    place: /reykjav/i, country: ['ic'], years: [1934, 1990],
  },

  // --- Palestinian Marxist and communist organisations, and Rakah -----------
  {
    id: 'pflp',
    search: ['Popular Front for the Liberation of Palestine', 'Jabhah al-Shaʻbīyah li-Taḥrīr Filasṭīn', 'P.F.L.P.'],
    match: /popular\s+front\s+for\s+the\s+liberation\s+of\s+palestine|^(information\s+department|foreign\s+relations\s+comm?ittee),?\s+p\.f\.l\.p|^(al-)?jabhah\s+al-sha\S*\s+li-ta\S*\s+filas\S*|^الجبهة الشعبية لتحرير فلسطين/i,
    place: /./, country: ['le', 'sy', 'ws', 'gz', 'xx'], years: [1967, 2030],
    allowNoPlace: true,
  },
  {
    id: 'dflp',
    search: ['Democratic Front for the Liberation of Palestine', 'D.F.L.P.'],
    match: /democratic\s+front\s+for\s+the\s+liberation\s+of\s+palestine|^d\.?f\.?l\.?p\.?$/i,
    place: /./, country: ['le', 'sy', 'ws', 'gz', 'xx', 'gw'], years: [1969, 2030],
    allowNoPlace: true,
  },
  {
    id: 'palestinian-communist-party',
    search: ['Palestinian Communist Party'],
    match: /palestin(e|ian)\s+communist\s+party|palestinian\s+people'?s\s+party/i,
    place: /./, country: ['ws', 'gz', 'xx', 'le', 'jo'], years: [1982, 2030],
    allowNoPlace: true,
  },
  {
    id: 'rakah',
    search: ['Communist Party of Israel', 'Rakah'],
    match: /communist\s+party\s+of\s+israel|ha-?miflagah\s+ha-?[kḳ]omunis[tṭ]it\s+ha-?yi[sś]re/i,
    place: /tel[-\s]?aviv|haifa|jerusalem|nazareth|israel/i, country: ['is'], years: [1965, 1991],
    allowNoPlace: true,
  },

  // --- Further houses of the Arab world, Africa, Japan, West Germany and Portugal
  {
    id: 'otsuki-shoten',
    search: ['Ōtsuki Shoten', 'Otsuki Shoten'],
    match: /^([ōo]tsuki\s*shoten|大月書店)\.?$/i,
    place: /t[oō]ky[oō]|東京/i, country: ['ja'], years: [1946, 1991],
    allowNoPlace: true,
  },
  {
    id: 'aoki-shoten',
    search: ['Aoki Shoten'],
    match: /^(aoki\s*shoten|青木書店)\.?$/i,
    place: /t[oō]ky[oō]|東京/i, country: ['ja'], years: [1945, 1991],
    allowNoPlace: true,
  },
  {
    id: 'trikont-verlag',
    search: ['Trikont'],
    match: /^trikont([-\s]?verlag)?\.?$/i,
    place: /m[üu]nchen|munich|k[öo]ln/i, country: ['gw'], years: [1967, 1990],
  },
  {
    id: 'oberbaumverlag',
    search: ['Oberbaumverlag'],
    match: /^oberbaum([-\s]?verlag|presse)?\.?$/i,
    place: /berlin/i, country: ['gw'], years: [1966, 1990],
  },
  {
    id: 'verlag-rote-fahne',
    search: ['Verlag Rote Fahne'],
    match: /^verlag\s+rote\s+fahne\.?$/i,
    place: /berlin|dortmund|k[öo]ln/i, country: ['gw'], years: [1970, 1980],
  },
  {
    id: 'editorial-caminho',
    search: ['Editorial Caminho'],
    match: /^(editorial\s+)?caminho\.?$/i,
    place: /lisboa|lisbon/i, country: ['po'], years: [1975, 1991],
  },
  {
    id: 'dar-al-taliah',
    search: ['Dār al-Ṭalīʻah', "Dar al-Tali'a"],
    match: /^d[aā]r\s+al[-\s]?[tṭ]al[iī].?ah?\.?$|^دار الطليعة$/i,
    place: /bay?r[uū]t|beirut|beyrouth|lebanon|lubn/i, country: ['le'], years: [1959, 2030],
    allowNoPlace: true,
  },
  {
    id: 'lebanese-communist-party',
    search: ['al-Ḥizb al-Shuyūʻī al-Lubnānī', 'Lebanese Communist Party'],
    match: new RegExp("ḥizb\\s+al-shuy\\S*\\s+al-lubn" + '|lebanese\\s+communist\\s+party|الحزب الشيوعي اللبناني', 'i'),
    place: /bay?r[uū]t|beirut|lebanon|lubn/i, country: ['le'], years: [1924, 2030],
    allowNoPlace: true,
  },
  {
    id: 'iraqi-communist-party',
    search: ['al-Ḥizb al-Shuyūʻī al-ʻIrāqī', 'Iraqi Communist Party'],
    match: new RegExp("ḥizb\\s+al-shuy\\S*\\s+al-\\S?ir[aā]q" + '|iraqi\\s+communist\\s+party|الحزب الشيوعي العراقي', 'i'),
    place: /./, country: ['iq', 'xx'], years: [1934, 2030],
    allowNoPlace: true,
  },
  {
    id: 'syrian-communist-party',
    search: ['al-Ḥizb al-Shuyūʻī al-Sūrī'],
    match: new RegExp("ḥizb\\s+al-shuy\\S*\\s+al-s[uū]r[iī]" + '|syrian\\s+communist\\s+party|الحزب الشيوعي السوري', 'i'),
    place: /./, country: ['sy', 'xx'], years: [1924, 2030],
    allowNoPlace: true,
  },
  {
    id: 'sudanese-communist-party',
    search: ['al-Ḥizb al-Shuyūʻī al-Sūdānī', 'Sudanese Communist Party'],
    match: new RegExp("ḥizb\\s+al-shuy\\S*\\s+al-s[uū]d[aā]n" + '|sudanese\\s+communist\\s+party|الحزب الشيوعي السوداني', 'i'),
    place: /./, country: ['sj', 'xx'], years: [1946, 2030],
    allowNoPlace: true,
  },
  {
    id: 'bilim-ve-sosyalizm',
    search: ['Bilim ve Sosyalizm'],
    match: /^bilim\s+ve\s+sosyalizm(\s+yay\S*)?\.?$/i,
    place: /ankara|istanbul|t[üu]rk/i, country: ['tu'], years: [1960, 2030],
    allowNoPlace: true,
  },
  {
    id: 'parti-democratique-de-guinee',
    search: ['Parti démocratique de Guinée'],
    match: /parti\s+d[ée]mocratique\s+de\s+guin[ée]e/i,
    place: /conakry|conacry|guin/i, country: ['gv'], years: [1947, 1984],
    allowNoPlace: true,
  },
  {
    id: 'imprimerie-patrice-lumumba',
    search: ['Imprimerie Patrice Lumumba'],
    match: /^(impr(imerie|\.)\s+(nationale\s+)?)?["“]?patrice\s+lumumba["”]?,?\.?$/i,
    place: /conakry|conacry|guin/i, country: ['gv'], years: [1958, 1984],
    allowNoPlace: true,
  },
  {
    id: 'parti-congolais-du-travail',
    search: ['Parti congolais du travail'],
    match: /parti\s+congolais\s+du\s+travail|^p\.?c\.?t\.?$/i,
    place: /brazzaville|congo/i, country: ['cf'], years: [1969, 1991],
    allowNoPlace: true,
  },
  {
    id: 'parti-de-la-revolution-populaire-du-benin',
    search: ['Parti de la révolution populaire du Bénin'],
    match: /parti\s+de\s+la\s+r[ée]volution\s+populaire\s+du\s+b[ée]nin/i,
    place: /cotonou|contonou|porto-novo|b[ée]nin/i, country: ['dm'], years: [1975, 1990],
    allowNoPlace: true,
  },
  {
    id: 'conseil-national-de-la-revolution',
    search: ['Conseil national de la révolution'],
    match: /conseil\s+national\s+de\s+la\s+r[ée]volution/i,
    place: /ouaga|burkina|nahouri|p[ôo]/i, country: ['uv'], years: [1983, 2030],
    allowNoPlace: true,
  },
  {
    id: 'convention-peoples-party',
    search: ["Convention People's Party"],
    match: /convention\s+people'?s\s+party/i,
    place: /accra|ghana|cape\s+coast|kumasi/i, country: ['gh'], years: [1949, 2030],
    allowNoPlace: true,
  },

  // --- Morocco and the Gulf ------------------------------------------------------
  {
    id: 'parti-du-progres-et-du-socialisme',
    search: ['Parti du progrès et du socialisme', 'Ḥizb al-Taqaddum wa-al-Ishtirākīyah'],
    match: /parti\s+du\s+progr[èe]s\s+et\s+du\s+socialisme|[hḥ]izb\s+al-taqaddum\s+wa-al-ishtir[aā]k[iī]yah/i,
    place: /casablanca|rabat|maroc|morocco|al-d[aā]r\s+al-bay/i, country: ['mr'], years: [1974, 2030],
    allowNoPlace: true,
  },
  {
    id: 'gulf-committee',
    search: ['Gulf Committee'],
    match: /^gulf\s+(solidarity\s+)?committee\.?$/i,
    place: /london/i, country: ['enk', 'xxk'], years: [1968, 1985],
  },

  // --- Fifth round: Iran, Bangladesh, Latin America and further African parties
  {
    id: 'tudeh-party-of-iran',
    search: ["Tudeh Party of Iran","Ḥizb-i Tūdah-i Īrān"],
    match: /[hḥ]izb-i\s+t[uū]dah-.?i\s+[iī]r[aā]n|^حزب توده ایران$/i,
    place: /./, country: ["ir","gw","ge","sw","xx"], years: [1941,2030],
    allowNoPlace: true,
  },
  {
    id: 'fedaian',
    search: ["Organisation of Iranian People's Fedai Guerrillas","Fedaian","Sāzmān-i Fadāʼīyān-i Khalq-i Īrān"],
    match: /s[aā]zm[aā]n-i\s+(ittiḥ[aā]d-i\s+)?f[ai]d[aā].?[iī]y+[aā]n|fedaian|organisation\s+of\s+iranian\s+people'?s\s+fedai/i,
    place: /./, country: ["ir","gw","fr","sw","xx"], years: [1971,2030],
    allowNoPlace: true,
  },
  {
    id: 'communist-party-of-bangladesh',
    search: ["Communist Party of Bangladesh","Bāṃlādeśera Kamiunisṭa Pārṭi","CPB"],
    match: /b[aā][mṃ]l[aā]de[sś]era\s+kamiunis[tṭ]a\s+p[aā]r[tṭ]i|communist\s+party\s+of\s+bangladesh/i,
    place: /./, country: ["bg","xx"], years: [1968,2030],
    allowNoPlace: true,
  },
  {
    id: 'partido-comunista-paraguayo',
    search: ["Partido Comunista Paraguayo","Paraguayan Communist Party"],
    match: /partido\s+comunista\s+paraguayo/i,
    place: /./, country: ["py","xx"], years: [1928,2030],
    allowNoPlace: true,
  },
  {
    id: 'partido-comunista-de-venezuela',
    search: ["Partido Comunista de Venezuela","PCV","Communist Party of Venezuela"],
    match: /partido\s+comunista\s+de\s+venezuela/i,
    place: /./, country: ["ve","xx"], years: [1931,2030],
    allowNoPlace: true,
  },
  {
    id: 'partido-del-pueblo-de-panama',
    search: ["Partido del Pueblo", "Partido del Pueblo de Panamá","People's Party of Panama"],
    match: /^partido\s+del\s+pueblo(\s+de\s+panam[aá])?\.?$/i,
    place: /panam/i, country: ["pn"], years: [1943,1991],
    allowNoPlace: true,
  },
  {
    id: 'partido-vanguardia-popular',
    search: ["Partido Vanguardia Popular","Vanguardia Popular","Popular Vanguard Party"],
    match: /vanguardia\s+popular/i,
    place: /costa\s+rica|san\s+jos/i, country: ["cr"], years: [1943,2030],
    allowNoPlace: true,
  },
  {
    id: 'partido-comunista-de-honduras',
    search: ["Partido Comunista de Honduras","Communist Party of Honduras"],
    match: /partido\s+comunista\s+de\s+honduras/i,
    place: /./, country: ["ho","xx"], years: [1954,1991],
    allowNoPlace: true,
  },
  {
    id: 'fmln',
    search: ["Frente Farabundo Martí para la Liberación Nacional","FMLN","Ediciones Sistema Radio Venceremos"],
    match: /frente\s+farabundo\s+mart[ií]|^fmln\b|radio\s+venceremos/i,
    place: /./, country: ["es","xx","mx"], years: [1980,2030],
    allowNoPlace: true,
  },
  {
    id: 'partido-guatemalteco-del-trabajo',
    search: ["Partido Guatemalteco del Trabajo","PGT","Guatemalan Party of Labour"],
    match: /partido\s+guatemalteco\s+del\s+trabajo/i,
    place: /./, country: ["gt","xx","mx"], years: [1949,1998],
    allowNoPlace: true,
  },
  {
    id: 'partido-comunista-dominicano',
    search: ["Partido Comunista Dominicano","Dominican Communist Party","PCD"],
    match: /partido\s+comunista\s+dominicano/i,
    place: /santo\s+domingo|dominican/i, country: ["dr"], years: [1944,1996],
    allowNoPlace: true,
  },
  {
    id: 'union-des-populations-du-cameroun',
    search: ["Union des populations du Cameroun","UPC","Union of the Peoples of Cameroon"],
    match: /union\s+des\s+populations\s+du\s+cameroun/i,
    place: /./, country: ["cm","enk","fr","xx"], years: [1948,2030],
    allowNoPlace: true,
  },
  {
    id: 'zanu',
    search: ["Zimbabwe African National Union","ZANU","ZANU-PF"],
    match: /zimbabwe\s+african\s+national\s+union/i,
    place: /./, country: ["rh","nyu","xx"], years: [1963,1990],
    allowNoPlace: true,
  },
  {
    id: 'frente-polisario',
    search: ["Frente Polisario","Polisario Front"],
    match: /frente\s+polisario/i,
    place: /./, country: ["ss","po","sp","xx"], years: [1973,2030],
    allowNoPlace: true,
  },
  {
    id: 'movement-for-justice-in-africa',
    search: ["Movement for Justice in Africa","MOJA"],
    match: /movement\s+for\s+justice\s+in\s+africa/i,
    place: /monrovia|liberia/i, country: ["lb"], years: [1973,2030],
    allowNoPlace: true,
  },
  {
    id: 'and-jef',
    search: ["And-Jëf/MRDN","And-Jëf","Mouvement révolutionnaire pour la démocratie nouvelle"],
    match: /^and-j[ëe]f/i,
    place: /dakar|s[ée]n[ée]gal/i, country: ["sg"], years: [1974,2030],
    allowNoPlace: true,
  },
  {
    id: 'mwakenya',
    search: ["Mwakenya","Muungano wa Wazalendo wa Kukomboa Kenya"],
    match: /^mwakenya\.?$/i,
    place: /./, country: ["ke","xx","enk"], years: [1982,2000],
    allowNoPlace: true,
  },

  // --- Hungary -----------------------------------------------------------------------------
  {
    id: 'kossuth-konyvkiado',
    search: ['Kossuth Könyvkiadó', 'Szikra'],
    match: /^kossuth(\s+k[öo]nyvkiad[óo]|\s+kiad[óo])?\.?$|^szikra(\s+kiad[áa]s)?\.?$/i,
    place: /budapest|szeged/i, country: ['hu'], years: [1944, 1990],
  },
  {
    id: 'mszmp',
    search: ['Magyar Szocialista Munkáspárt'],
    match: /magyar\s+szocialista\s+munk[áa]sp[áa]rt/i,
    place: /./, country: ['hu'], years: [1956, 1989],
    allowNoPlace: true,
  },

  // --- Luxembourg --------------------------------------------------------------------------
  {
    id: 'cope-luxembourg',
    search: ["Coopérative ouvrière de presse et d'éditions"],
    match: /^coop[ée]rative\s+ouvri[èe]re\s+de\s+presse\s+et\s+d'?\s*[ée]ditions\.?$/i,
    place: /luxemb|esch/i, country: ['lu'], years: [1946, 2030],
  },

  // --- Sixth round: southern Africa, the Indian Ocean, Korea, Timor and the Caribbean
  {
    id: 'swapo',
    search: ["SWAPO","South West Africa People's Organisation"],
    match: /^swapo\.?$|south\s+west\s+africa\s+people'?s\s+organi[sz]ation/i,
    place: /./, country: ["sx","ao","tz","nyu","xx"], years: [1960,1990],
    allowNoPlace: true,
  },
  {
    id: 'mlstp',
    search: ["MLSTP","Movimento de Libertação de São Tomé e Príncipe"],
    match: /^m\.?l\.?s\.?t\.?p\.?(\/psd)?\.?$|movimento\s+(de\s+)?liberta[çc][ãa]o\s+de\s+s(ão|\.)\s+tom[ée]/i,
    place: /./, country: ["sf","xx"], years: [1972,1991],
    allowNoPlace: true,
  },
  {
    id: 'seychelles-peoples-progressive-front',
    search: ["Seychelles People's Progressive Front","SPPF"],
    match: /seychelles\s+people'?s\s+progressive\s+front/i,
    place: /./, country: ["se","xx"], years: [1978,1993],
    allowNoPlace: true,
  },
  {
    id: 'mouvement-militant-mauricien',
    search: ["Mouvement militant mauricien","MMM"],
    match: /mouvement\s+militant\s+mauricien/i,
    place: /./, country: ["mf","xx"], years: [1969,2030],
    allowNoPlace: true,
  },
  {
    id: 'somali-revolutionary-socialist-party',
    search: ["Somali Revolutionary Socialist Party","Xisbiga Hantiwadaagga Kacaanka Soomaaliyeed"],
    match: /xisbiga\s+hantiwadaagga\s+kacaanka\s+soomaa?liyeed|somali\s+revolutionary\s+socialist\s+party/i,
    place: /./, country: ["so","xx"], years: [1969,1991],
    allowNoPlace: true,
  },
  {
    id: 'paeksan-sodang',
    search: ["Paeksan Sŏdang","Baeksan Seodang"],
    match: /^(paeksan\s*s[ŏo]dang|baeksan\s*seodang|백산서당)\.?$/i,
    place: /s[ŏoe]{1,2}ul|서울/i, country: ["ko"], years: [1980,1995],
    allowNoPlace: true,
  },
  {
    id: 'fretilin',
    search: ["FRETILIN","Frente Revolucionária de Timor-Leste Independente"],
    match: /fretilin|frente\s+revolucion[áa]ria?\s+d[eo]\s+timor/i,
    place: /./, country: ["mz","po","at","xx"], years: [1974,2002],
    allowNoPlace: true,
  },
  {
    id: 'oilfields-workers-trade-union',
    search: ["Oilfields Workers' Trade Union","OWTU"],
    match: /oilfields?\s+workers'?\s+trade\s+union/i,
    place: /trinidad|san\s+fernando|port.of.spain/i, country: ["tr"], years: [1937,2030],
    allowNoPlace: true,
  },
  {
    id: 'yulimo',
    search: ["YULIMO","Youlou United Liberation Movement"],
    match: /^yulimo\.?$|youlou\s+united\s+liberation/i,
    place: /./, country: ["xm","xx"], years: [1970,1994],
    allowNoPlace: true,
  },
  {
    id: 'movement-for-national-liberation-barbados',
    search: ["Movement for National Liberation","MONALI"],
    match: /movement\s+for\s+national\s+liberation/i,
    place: /barbados|st\.?\s*michael|bridgetown/i, country: ["bb"], years: [1970,2030],
  },
  {
    id: 'outlet-publishers',
    search: ["Outlet Publishers","Outlet"],
    match: /^outlet\s+publishers(\s+ltd\.?)?$/i,
    place: /antigua|st\.?\s*john/i, country: ["aq"], years: [1968,2002],
  },

  // --- Malaysia ----------------------------------------------------------------------------
  {
    id: 'parti-rakyat-malaysia',
    search: ['Parti Rakyat Malaysia', 'Partai Rakyat Malaysia'],
    match: /^part[a]?i\s+rakyat\s+malaysia\.?$/i,
    place: /kuala\s+lumpur|malaysia/i, country: ['my'], years: [1955, 2030],
    allowNoPlace: true,
  },

  // --- Seventh round: the political and party presses of the Soviet republics, the Warsaw Pact
  // states and Yugoslavia, with their military, trade-union and foreign-propaganda houses
  {
    id: 'voenizdat',
    search: ["Voenizdat","Voennoe izd-vo"],
    match: /^[\s\["“”«»'(]*(voenizdat|(izd(-vo|\.|atel.stvo)\s+)?voennoe\s+izd(-vo|\.|atelʹstvo|atel'stvo)(\s+ministerstva\s+oborony\s+sssr)?|воениздат|военное\s+изд)[\s\]"“”«»'),.;:]*$/i,
    place: /mosk|moscow|leningrad/i, country: ["ru","ur"], years: [1919,1991],
  },
  {
    id: 'moskovskii-rabochii',
    search: ["Moskovskiĭ rabochiĭ","Moskovskii rabochii"],
    match: /^[\s\["“”«»'(]*(moskovski[iĭǐj]\s+rabo(ch|č)i[iĭǐj]|московский\s+рабочий)[\s\]"“”«»'),.;:]*$/i,
    place: /mosk|moscow/i, country: ["ru","ur"], years: [1922,1991],
  },
  {
    id: 'lenizdat',
    search: ["Lenizdat"],
    match: /^[\s\["“”«»'(]*(lenizdat|лениздат)[\s\]"“”«»'),.;:]*$/i,
    place: /leningrad|petersburg|peterburg/i, country: ["ru","ur"], years: [1930,1991],
  },
  {
    id: 'profizdat',
    search: ["Profizdat"],
    match: /^[\s\["“”«»'(]*((izd(-vo|atelʹstvo)\s+vt\S*\s+)?profizdat|профиздат|trade.union\s+publishing\s+house\s+profizdat)[\s\]"“”«»'),.;:]*$/i,
    place: /mosk|moscow/i, country: ["ru","ur"], years: [1918,1991],
    // Sofia's Профиздат shares the name; its Bulgarian books are not the Moscow house's (CiNii has no place).
    exclude: (t) => /^Bulgarian/.test(t.language),
  },
  {
    id: 'izdatelstvo-pravda',
    search: ["Izd-vo Pravda","Izd-vo \"Pravda\""],
    match: /^[\s\["“”«»'(]*(izd(-vo|\.|atelʹstvo)\s+["“«]?pravda["”»]?|издательство\s+«?правда»?)[\s\]"“”«»'),.;:]*$/i,
    place: /mosk|moscow/i, country: ["ru","ur"], years: [1918,1991],
  },
  {
    id: 'mysl',
    search: ["Mysl'","Mysl"],
    match: /^[\s\["“”«»'(]*(mysl['ʹ’]?|мысль)[\s\]"“”«»'),.;:]*$/i,
    place: /mosk|moscow/i, country: ["ru","ur"], years: [1963,1991],
  },
  {
    id: 'gosizdat',
    search: ["Gosizdat","Gosudarstvennoe izdatelʹstvo"],
    match: /^[\s\["“”«»'(]*(gosizdat|gosudarstvennoe\s+izdatel[ʹ']?stvo|госиздат|государственное\s+издательство)[\s\]"“”«»'),.;:]*$/i,
    place: /mosk|moscow|leningrad|petrograd|peterburg/i, country: ["ru","ur"], years: [1919,1930],
  },
  {
    id: 'sovetskaia-rossiia',
    search: ["Sovetskaia Rossiia","Sovetskaya Rossiya"],
    match: /^[\s\["“”«»'(]*((izd(-vo|\.|atel.stvo)\s+)?sovetska\S*\s+rossi\S*|советская\s+россия)[\s\]"“”«»'),.;:]*$/i,
    place: /mosk|moscow/i, country: ["ru","ur"], years: [1957,1991],
  },
  {
    id: 'priboi',
    search: ["Priboĭ","Priboi"],
    match: /^[\s\["“”«»'(]*((izd(-vo|\.|atel.stvo)\s+)?pribo[iĭǐ]|прибой)[\s\]"“”«»'),.;:]*$/i,
    place: /leningrad|petrograd|peterburg/i, country: ["ru","ur"], years: [1922,1930],
  },
  {
    id: 'krasnaia-nov',
    search: ["Krasnaia nov'","Krasnai︠a︡ novʹ"],
    match: /^[\s\["“”«»'(]*((izd(-vo|\.|atel.stvo)\s+)?["“«]?krasna\S*\s+nov[ʹ'’]?["”»]?(,?\s+glavpolitprosvet)?|красная\s+новь)[\s\]"“”«»'),.;:]*$/i,
    place: /mosk|moscow/i, country: ["ru","ur"], years: [1922,1925],
  },
  {
    id: 'communist-academy',
    search: ["Izd-vo Kommunisticheskoĭ akademii"],
    match: /^[\s\["“”«»'(]*(izd(-vo|\.|atelʹstvo)\s+(sotsialisticheskoi|sotsialisticheskoĭ|kommunisticheskoi|kommunisticheskoĭ)\s+akademii|издательство\s+коммунистической\s+академии)[\s\]"“”«»'),.;:]*$/i,
    place: /mosk|moscow/i, country: ["ru","ur"], years: [1918,1936],
  },
  {
    id: 'politvydav-ukrainy',
    search: ["Politvydav Ukraïny","Vyd-vo polit. lit-ry Ukraïny","Derzh. vyd-vo polit. lit-ry URSR"],
    match: /^[\s\["“”«»'(]*(politvydav\s+ukra\S*|(derzh\S*\s+)?vyd(-vo|avnytstvo)\s+polit(\.|ychnoï|ychnoi)\s*lit(\.|-ry|eratury)\s+(ukra\S*|ursr)|політвидав\s+україни)[\s\]"“”«»'),.;:]*$/i,
    place: /ky[iï]v|kiev|kyı̈v|kiïv|kharʹkov|kharkiv/i, country: ["un","ur"], years: [1922,1991],
  },
  {
    id: 'belarus-publishing-house',
    search: ["Belarusʹ","Belarus'"],
    match: /^[\s\["“”«»'(]*((izd(-vo|\.|atel.stvo)\s+)?belarus[ʹ'’]?|беларусь)[\s\]"“”«»'),.;:]*$/i,
    place: /minsk|minst/i, country: ["bw","ur"], years: [1921,1991],
  },
  {
    id: 'mintis',
    search: ["Mintis","Valstybinė politinės ir mokslinės literatūros leidykla"],
    match: /^[\s\["“”«»'(]*(mintis(\s+publishers)?|valstybin[ėe]\s+politin[ėe]s\s+ir\s+mokslin[ėe]s\s+literat[ūu]ros\s+leidykla)[\s\]"“”«»'),.;:]*$/i,
    place: /viln|vil.ni/i, country: ["li","ur"], years: [1949,1991],
  },
  {
    id: 'latvian-state-publishing-house',
    search: ["Latvijas Valsts izdevniecība","Latvijas valsts izdevnieciba"],
    match: /^[\s\["“”«»'(]*(latvijas\s+valsts\s+izdevniec[īi]ba|lvi)[\s\]"“”«»'),.;:]*$/i,
    place: /r[īi]g/i, country: ["lv","ur"], years: [1940,1965],
  },
  {
    id: 'avots',
    search: ["Avots"],
    match: /^[\s\["“”«»'(]*((izdevniec[īi]ba\s+)?avots)[\s\]"“”«»'),.;:]*$/i,
    place: /r[īi]g/i, country: ["lv","ur"], years: [1980,1991],
  },
  {
    id: 'eesti-riiklik-kirjastus',
    search: ["Eesti Riiklik Kirjastus"],
    match: /^[\s\["“”«»'(]*(eesti\s+riiklik\s+kirjastus)[\s\]"“”«»'),.;:]*$/i,
    place: /tallin|tartu/i, country: ["er","ur"], years: [1940,1964],
  },
  {
    id: 'eesti-raamat',
    search: ["Eesti Raamat"],
    match: /^[\s\["“”«»'(]*((kirjastus\s+["“«]?)?eesti\s+raamat)[\s\]"“”«»'),.;:]*$/i,
    place: /tallin|tartu/i, country: ["er","ur"], years: [1964,1991],
  },
  {
    id: 'sabchota-sakartvelo',
    search: ["Sabchota Sakartvelo"],
    match: /^[\s\["“”«»'(]*((izd(-vo|\.|atel.stvo)\s+)?sabchota\s+sakartvelo|საბჭოთა\s+საქართველო)[\s\]"“”«»'),.;:]*$/i,
    place: /t.?bilis/i, country: ["gs","ur"], years: [1921,1991],
  },
  {
    id: 'hayastan',
    search: ["Hayastan","Hayastan Hratarakchʻutʻyun"],
    match: /^[\s\["“”«»'(]*(hayastan(\s+hratarakch\S*)?|["“]hayastan["”]\s+hratarakch\S*|հայաստան)[\s\]"“”«»'),.;:]*$/i,
    place: /erevan|yerevan/i, country: ["ai","ur"], years: [1921,1991],
  },
  {
    id: 'azerneshr',
    search: ["Azerneshr","Azərnəşr"],
    match: /^[\s\["“”«»'(]*(azerne(sh|ş)r|azərnəşr|азернешр)[\s\]"“”«»'),.;:]*$/i,
    place: /baku|bak[ıy]/i, country: ["aj","ur"], years: [1923,1991],
  },
  {
    id: 'kazakhstan-publishing-house',
    search: ["Kazakhstan","Izd-vo \"Kazakhstan\""],
    match: /^[\s\["“”«»'(]*((izd(-vo|\.|atel.stvo)\s+)?["“«]?kazakhstan["”»]?|«?казахстан»?)[\s\]"“”«»'),.;:]*$/i,
    place: /alma|almaty/i, country: ["kz","ur"], years: [1920,1991],
  },
  {
    id: 'uzbekistan-publishing-house',
    search: ["Ŭzbekiston","Uzbekiston","Uzbekistan"],
    match: /^[\s\["“”«»'(]*((izd(-vo|\.|atel.stvo)\s+)?["“«]?(ŭ|u|o')zbekist[oa]n["”»]?(\s+nashri[eë]ti)?|«?узбекистан»?)[\s\]"“”«»'),.;:]*$/i,
    place: /tosh|tash/i, country: ["uz","ur"], years: [1926,1991],
  },
  {
    id: 'kyrgyzstan-publishing-house',
    search: ["Kyrgyzstan"],
    match: /^[\s\["“”«»'(]*((izd(-vo|\.|atel.stvo)\s+)?["“«]?kyrgyzstan["”»]?(\s+basmasy)?|«?кыргызстан»?)[\s\]"“”«»'),.;:]*$/i,
    place: /frunze|frinze|bishkek/i, country: ["kg","ur"], years: [1926,1991],
  },
  {
    id: 'irfon',
    search: ["Irfon"],
    match: /^[\s\["“”«»'(]*((nashri[eë]ti\s+|izd-vo\s+)?["“«]?irfon["”»]?|ирфон)[\s\]"“”«»'),.;:]*$/i,
    place: /dushanbe|stalinabad/i, country: ["ta","ur"], years: [1928,1991],
  },
  {
    id: 'turkmenistan-publishing-house',
    search: ["Turkmenistan"],
    match: /^[\s\["“”«»'(]*((izd(-vo|\.|atel.stvo)\s+)?["“«]?turkmenistan["”»]?(\s+(neshiriaty|rnchb))?|«?туркменистан»?)[\s\]"“”«»'),.;:]*$/i,
    place: /ash.?h?a?bad|ashgabat|aşgabat|așgabat|ashghabat/i, country: ["tk","ur"], years: [1925,1991],
  },
  {
    id: 'kartia-moldoveniaske',
    search: ["Kartia moldoveniaske","Kartii︠a︡ moldoveni︠a︡skė"],
    match: /^[\s\["“”«»'(]*(karti\S*\s+moldoveni\S*|cartea\s+moldoveneasc[ăa]|картя\s+молдовеняскэ)[\s\]"“”«»'),.;:]*$/i,
    place: /kishin|chi[șş]in|tiraspol/i, country: ["mv","ur"], years: [1925,1991],
  },
  {
    id: 'militarverlag-der-ddr',
    search: ["Militärverlag der DDR","Deutscher Militärverlag"],
    match: /^[\s\["“”«»'(]*((deutscher\s+)?milit[äa]rverlag(\s+der\s+(ddr|deutschen\s+demokratischen\s+republik))?|verlag\s+des\s+ministeriums\s+f[üu]r\s+nationale\s+verteidigung)[\s\]"“”«»'),.;:]*$/i,
    place: /berlin|east germany/i, country: ["ge","gw"], years: [1956,1990],
  },
  {
    id: 'staatsverlag-der-ddr',
    search: ["Staatsverlag der DDR"],
    match: /^[\s\["“”«»'(]*(staatsverlag,?\s+der\s+(ddr|deutschen\s+demokratischen\s+republik|dt\.\s+demokrat\.\s+republik))[\s\]"“”«»'),.;:]*$/i,
    place: /berlin/i, country: ["ge","gw"], years: [1950,1990],
  },
  {
    id: 'verlag-tribune',
    search: ["Verlag Tribüne"],
    match: /^[\s\["“”«»'(]*(verlag\s+trib[üu]ne|trib[üu]ne\s+verlag)[\s\]"“”«»'),.;:]*$/i,
    place: /berlin/i, country: ["ge","gw"], years: [1945,1990],
  },
  {
    id: 'verlag-zeit-im-bild',
    search: ["Verlag Zeit im Bild"],
    match: /^[\s\["“”«»'(]*(verlag\s+zeit\s+im\s+bild)[\s\]"“”«»'),.;:]*$/i,
    place: /dresden|berlin/i, country: ["ge","gw"], years: [1950,1990],
  },
  {
    id: 'panorama-ddr',
    search: ["Panorama DDR"],
    match: /^[\s\["“”«»'(]*(panorama(\s|-)ddr(-auslandspresseagentur)?)[\s\]"“”«»'),.;:]*$/i,
    place: /berlin|dresden/i, country: ["ge","gw"], years: [1960,1990],
  },
  {
    id: 'wydawnictwo-mon',
    search: ["Wydawnictwo Ministerstwa Obrony Narodowej","Wydawn. MON"],
    match: /^[\s\["“”«»'(]*(wyda?w(nictwo|n\.|\.)\s+(min(isterstwa|\.)\s+obrony\s+narod\S*|mon))[\s\]"“”«»'),.;:]*$/i,
    place: /warsz|warsaw/i, country: ["pl"], years: [1947,1990],
  },
  {
    id: 'interpress',
    search: ["Interpress","Interpress Publishers"],
    match: /^[\s\["“”«»'(]*((wyda?w(nictwo|n\.)\s+)?interpress(\s+publishers)?)[\s\]"“”«»'),.;:]*$/i,
    place: /warsz|warsaw|varsovie/i, country: ["pl"], years: [1967,1991],
  },
  {
    id: 'nase-vojsko',
    search: ["Naše vojsko"],
    match: /^[\s\["“”«»'(]*(na[šs]̌?e\s+vojsko)[\s\]"“”«»'),.;:]*$/i,
    place: /praha|praze|prague/i, country: ["xr","cs"], years: [1945,1990],
  },
  {
    id: 'prace',
    search: ["Práce"],
    match: /^[\s\["“”«»'(]*((nakladatelstv[ií]\s+|vydavatelstv[oí]\s+roh\s+)?pr[áa]ce)[\s\]"“”«»'),.;:]*$/i,
    place: /praha|praze|prague/i, country: ["xr","cs"], years: [1945,1990],
  },
  {
    id: 'orbis-prague',
    search: ["Orbis"],
    match: /^[\s\["“”«»'(]*(orbis)[\s\]"“”«»'),.;:]*$/i,
    place: /praha|praze|prague|prag/i, country: ["xr","cs"], years: [1948,1990],
  },
  {
    id: 'zrinyi-kiado',
    search: ["Zrínyi","Zrínyi Katonai Kiadó"],
    match: /^[\s\["“”«»'(]*(zr[íi]nyi(\s+katonai)?(\s+kiad[óo])?)[\s\]"“”«»'),.;:]*$/i,
    place: /budapest|budepest/i, country: ["hu"], years: [1949,1990],
  },
  {
    id: 'tancsics-konyvkiado',
    search: ["Táncsics Könyvkiadó","Táncsics"],
    match: /^[\s\["“”«»'(]*(t[áa]ncsics(\s+k[öo]nyvkiad[óo]|\s+kiad[óo])?)[\s\]"“”«»'),.;:]*$/i,
    place: /budapest/i, country: ["hu"], years: [1945,1990],
  },
  {
    id: 'editura-politica',
    search: ["Editura Politică","Editura de stat pentru literatură politică"],
    match: /^[\s\["“”«»'(]*(editura\s+politic[ăaǎ]|editura\s+(de\s+stat\s+)?pentru\s+literatur[ăa]\s+politic[ăa]|editura\s+partidului\s+muncitoresc\s+rom[âa]n)[\s\]"“”«»'),.;:]*$/i,
    place: /bucure|bucharest|bukarest/i, country: ["rm"], years: [1948,1989],
  },
  {
    id: 'editura-militara',
    search: ["Editura Militară"],
    match: /^[\s\["“”«»'(]*(editura\s+militar[ăaǎ])[\s\]"“”«»'),.;:]*$/i,
    place: /bucure|bucharest/i, country: ["rm"], years: [1950,1989],
  },
  {
    id: 'partizdat-sofia',
    search: ["Partizdat","Izd-vo na BKP"],
    match: /^[\s\["“”«»'(]*(partizdat|partĭzdat|izd(-vo|atelstvo)\s+(na\s+)?(bkp|b[ŭu]lgarskata\s+komunisticheska\s+partii?a)|партиздат)[\s\]"“”«»'),.;:]*$/i,
    place: /sofi/i, country: ["bu"], years: [1944,1990],
  },
  {
    id: 'bulgarian-state-military-publishing-house',
    search: ["Dŭrzhavno voenno izd-vo","Durzhavno voenno izd-vo","Voenno izd-vo"],
    match: /^[\s\["“”«»'(]*((d[ŭuǔ]rzh(avno|\.?\[avno\]|\.)?\]?\s+)?voenno\s+izd(-vo|atelstvo))[\s\]"“”«»'),.;:]*$/i,
    place: /sofi/i, country: ["bu"], years: [1944,1990],
  },
  {
    id: 'profizdat-sofia',
    search: ["Profizdat"],
    match: /^[\s\["“”«»'(]*(profizdat|профиздат)[\s\]"“”«»'),.;:]*$/i,
    place: /sofi/i, country: ["bu"], years: [1944,1990],
  },
  {
    id: 'kultura-belgrade',
    search: ["Kultura"],
    match: /^[\s\["“”«»'(]*(kultura|култура)[\s\]"“”«»'),.;:]*$/i,
    place: /beograd|belgrad/i, country: ["yu"], years: [1945,1991],
  },
  {
    id: 'rad-belgrade',
    search: ["Rad"],
    match: /^[\s\["“”«»'(]*((izdava[čc]ko\s+preduze[ćc]e\s+)?rad|рад)[\s\]"“”«»'),.;:]*$/i,
    place: /beograd|belgrad/i, country: ["yu"], years: [1949,1991],
  },
  {
    id: 'borba-belgrade',
    search: ["Borba"],
    match: /^[\s\["“”«»'(]*((izdava[čc]ko\s+preduze[ćc]e\s+)?borba|борба)[\s\]"“”«»'),.;:]*$/i,
    place: /beograd|belgrad/i, country: ["yu"], years: [1922,1991],
  },
  {
    id: 'naprijed',
    search: ["Naprijed"],
    match: /^[\s\["“”«»'(]*((izdanje\s+|izdava[čc]ko\s+poduze[ćc]e\s+)?naprijed)[\s\]"“”«»'),.;:]*$/i,
    place: /zagreb/i, country: ["yu","ci"], years: [1945,1991],
  },
  {
    id: 'vojnoizdavacki-zavod',
    search: ["Vojnoizdavački zavod"],
    match: /^[\s\["“”«»'(]*(vojnoizdava[čc]ki\s+zavod(\s+jna)?|војноиздавачки\s+завод)[\s\]"“”«»'),.;:]*$/i,
    place: /beograd|belgrad/i, country: ["yu"], years: [1945,1991],
  },

  // --- Eighth round: socialist presses of the Russian Empire and of Eastern Europe before communist
  // rule; China's pre-1949 Communist presses and provincial party presses; Korea, Vietnam and Cuba
  {
    id: 'znanie-st-petersburg',
    search: ["Znanie"],
    match: /^[\s\["“”«»'(]*((knigoizdatelʹskoe\s+)?(tovarishchestvo\s+)?["“«]?znani[eī]e?["”»]?)[\s\]"“”«»'),.;:]*$/i,
    place: /peterburg|petersburg|spb/i, country: ["ru"], years: [1898,1913],
  },
  {
    id: 'molot',
    search: ["Molot"],
    match: /^[\s\["“”«»'(]*((kn(-vo|igoizdatelʹstvo)\s+|izd(-vo|\.)\s+)?["“«]?molot["”»]?)[\s\]"“”«»'),.;:]*$/i,
    place: /peterburg|petersburg|spb/i, country: ["ru"], years: [1905,1908],
  },
  {
    id: 'zhizn-i-znanie',
    search: ["Zhizn' i znanie","Zhiznʹ i znanīe"],
    match: /^[\s\["“”«»'(]*((kn(-vo|igoizdatelʹstvo)\s+)?["“«]?zhizn[ʹ'’]?\s+i\s+znan[iī]e["”»]?)[\s\]"“”«»'),.;:]*$/i,
    place: /peterburg|petrograd|petersburg|moskva|moscow/i, country: ["ru"], years: [1909,1925],
  },
  {
    id: 'narodnoe-pravo',
    search: ["Narodnoe pravo"],
    match: /^[\s\["“”«»'(]*((izd\.\s+)?["“«]?narodnoe\s+pravo["”»]?)[\s\]"“”«»'),.;:]*$/i,
    place: /mosk|moscow/i, country: ["ru"], years: [1905,1918],
  },
  {
    id: 'donskaia-rech',
    search: ["Donskaia rech'","Donskai︠a︡ rechʹ"],
    match: /^[\s\["“”«»'(]*((izd\.\s+n\.\s+paramonova,?\s+)?["“«]?donska\S*\s+rech[ʹ'’]?["”»]?)[\s\]"“”«»'),.;:]*$/i,
    place: /rostov/i, country: ["ru"], years: [1900,1907],
  },
  {
    id: 'nepszava',
    search: ["Népszava"],
    match: /^[\s\["“”«»'(]*(n[ée]pszava(-?\s*k[öo]nyvkereskedés(\s+kiad[áa]sa)?)?)[\s\]"“”«»'),.;:]*$/i,
    place: /budapest/i, country: ["hu"], years: [1877,1948],
  },
  {
    id: 'ksiazka-1918',
    search: ["Książka"],
    match: /^[\s\["“”«»'(]*((sp[óo]łdzielnia\s+wydawnicza\s+)?["“«]?ksi[ąa̧]żka["”»]?)[\s\]"“”«»'),.;:]*$/i,
    place: /warsz|warsaw|krak[óo]w|ł[óo]d[źz]/i, country: ["pl"], years: [1918,1948],
  },
  {
    id: 'kultur-lige',
    search: ["Ḳulṭur-lige","Kultur-lige"],
    match: /^[\s\["“”«»'(]*((ḳooperaṭiṿer\s+farlag\s+|kooperativer\s+farlag\s+)?["“«]?[ḳk]ul[ṭt]ur[-\s]lige["”»]?)[\s\]"“”«»'),.;:]*$/i,
    place: /[ṿv]arsh|warsaw|warszaw|[ḳk]i[yi]?e[ṿv]|kiev|kyiv|byali|bia[łl]ystok/i, country: ["pl","un"], years: [1918,1939],
  },
  {
    id: 'ustredni-delnicke-knihkupectvi',
    search: ["Ústřední dělnické knihkupectví a nakladatelství"],
    match: /^[\s\["“”«»'(]*([úu]st[řr]edn[íi]\s+d[ěe]lnick[ée]\s+knihkupectv[íi].*)[\s\]"“”«»'),.;:]*$/i,
    place: /praha|praze|prague/i, country: ["xr","cs"], years: [1897,1938],
  },
  {
    id: 'shanghai-shudian-1923',
    search: ["Shanghai shu dian"],
    match: /^[\s\["“”«»'(]*(shanghai\s*shu\s*dian|上海书店|上海書店)[\s\]"“”«»'),.;:]*$/i,
    place: /shanghai|上海/i, country: ["cc"], years: [1923,1927],
  },
  {
    id: 'xinhua-shudian',
    search: ["Xin hua shu dian"],
    match: /^[\s\["“”«»'(]*(xin\s*hua\s*shu\s*dian|新华书店|新華書店|hsin\s*hua\s*shu\s*tien)[\s\]"“”«»'),.;:]*$/i,
    place: /./, country: ["cc"], years: [1937,1952],
    allowNoPlace: true,
  },
  {
    id: 'dongbei-shudian',
    search: ["Dong bei shu dian"],
    match: /^[\s\["“”«»'(]*(dong\s*bei\s*shu\s*dian|东北书店|東北書店)[\s\]"“”«»'),.;:]*$/i,
    place: /./, country: ["cc"], years: [1945,1951],
    allowNoPlace: true,
  },
  {
    id: 'shenghuo-shudian',
    search: ["Sheng huo shu dian"],
    match: /^[\s\["“”«»'(]*(sheng\s*huo\s*shu\s*dian|生活书店|生活書店)[\s\]"“”«»'),.;:]*$/i,
    place: /./, country: ["cc"], years: [1932,1948],
    allowNoPlace: true,
  },
  {
    id: 'dushu-chubanshe',
    search: ["Du shu chu ban she","Du shu sheng huo chu ban she"],
    match: /^[\s\["“”«»'(]*(du\s*shu\s*(sheng\s*huo\s*)?chu\s*ban\s*she|读书(生活)?出版社|讀書(生活)?出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /./, country: ["cc"], years: [1936,1948],
    allowNoPlace: true,
  },
  {
    id: 'xinzhi-shudian',
    search: ["Xin zhi shu dian"],
    match: /^[\s\["“”«»'(]*(xin\s*zhi\s*shu\s*dian|新知书店|新知書店)[\s\]"“”«»'),.;:]*$/i,
    place: /./, country: ["cc"], years: [1935,1948],
    allowNoPlace: true,
  },
  {
    id: 'sanlian-shudian',
    search: ["Sheng huo, du shu, xin zhi san lian shu dian","San lian shu dian"],
    match: /^[\s\["“”«»'(]*(sheng\s*huo,?\s*du\s*shu,?\s*xin\s*zhi\s*san\s*lian\s*shu\s*dian(\s+xianggang\s+fen\s+dian)?|(xianggang\s+)?san\s*lian\s*shu\s*dian|生活[·・]?读书[·・]?新知三联书店|三联书店|三聯書店)[\s\]"“”«»'),.;:]*$/i,
    place: /./, country: ["cc","hk"], years: [1948,1966],
    allowNoPlace: true,
  },
  {
    id: 'sahoe-kwahak-chulpansa',
    search: ["Sahoe Kwahak Chʻulpʻansa","Sahoe Kwahak Ch'ulp'ansa"],
    match: /^[\s\["“”«»'(]*(sahoe,?\s*kwahak\s*ch[ʻ']?ul\s*p[ʻ']?ansa|사회과학출판사)[\s\]"“”«»'),.;:]*$/i,
    place: /p.?y[ŏo]ngyang|평양|chos[ŏo]n/i, country: ["ko","kn"], years: [1950,2030],
  },
  {
    id: 'kungnip-chulpansa',
    search: ["Kungnip Chʻulpʻansa","Kungnip Ch'ulp'ansa"],
    match: /^[\s\["“”«»'(]*(kungnip\s*ch[ʻ']?ul\s*p[ʻ']?ansa|국립출판사)[\s\]"“”«»'),.;:]*$/i,
    place: /p.?y[ŏo]ngyang|평양/i, country: ["ko","kn"], years: [1945,1965],
  },
  {
    id: 'quan-doi-nhan-dan',
    search: ["Quân đội nhân dân","Nhà xuất bản Quân đội nhân dân"],
    match: /^[\s\["“”«»'(]*((nh[àa]\s+xu\S*\s+b[ảa]n\s+)?qu[âa]n\s+[đd][ộo]i\s+nh[âa]n\s+d[âa]n)[\s\]"“”«»'),.;:]*$/i,
    place: /h[àa][\s-]*n[ộọo]i|hanoi/i, country: ["vm"], years: [1950,1990],
  },
  {
    id: 'lao-dong-hanoi',
    search: ["Lao động"],
    match: /^[\s\["“”«»'(]*((nh[àa]\s+xu\S*\s+b[ảa]n\s+)?lao\s+[đd][ộo]ng)[\s\]"“”«»'),.;:]*$/i,
    place: /h[àa][\s-]*n[ộọo]i|hanoi/i, country: ["vm"], years: [1945,1990],
  },
  {
    id: 'editora-politica',
    search: ["Editora Política"],
    match: /^[\s\["“”«»'(]*(editora\s+pol[íi]tica)[\s\]"“”«»'),.;:]*$/i,
    place: /habana|havana/i, country: ["cu"], years: [1959,2030],
  },
  {
    id: 'editorial-capitan-san-luis',
    search: ["Editorial Capitán San Luis"],
    match: /^[\s\["“”«»'(]*((editorial\s+)?capit[áa]n\s+san\s+luis(,\s*editorial)?)[\s\]"“”«»'),.;:]*$/i,
    place: /habana|havana/i, country: ["cu"], years: [1977,2030],
  },
  // The Cuban state houses of the Instituto Cubano del Libro and the mass organizations.
  {
    id: 'editorial-nacional-de-cuba',
    search: ['Editorial Nacional de Cuba', 'Imprenta Nacional de Cuba'],
    match: /^[\s\["“”«»'(]*((editorial|imprenta)\s+nacional\s+de\s+cuba)[\s\]"“”«»'),.;:]*$/i,
    place: /habana|havana|cuba/i, country: ['cu'], years: [1959, 1968],
  },
  {
    id: 'instituto-cubano-del-libro',
    search: ['Instituto Cubano del Libro'],
    match: /^[\s\["“”«»'(]*(instituto\s+cubano\s+del\s+libro)/i,
    place: /habana|havana|cuba/i, country: ['cu'], years: [1967, 2030],
  },
  {
    id: 'editorial-arte-y-literatura',
    search: ['Arte y Literatura', 'Editorial Arte y Literatura'],
    match: /^[\s\["“”«»'(]*((editorial\s+)?arte\s+y\s+literatura)[\s\]"“”«»'),.;:]*$/i,
    place: /habana|havana|cuba/i, country: ['cu'], years: [1967, 2030],
  },
  {
    id: 'editorial-letras-cubanas',
    search: ['Letras Cubanas', 'Editorial Letras Cubanas'],
    match: /^[\s\["“”«»'(]*((editorial\s+)?letras\s+cubanas)[\s\]"“”«»'),.;:]*$/i,
    place: /habana|havana|cuba/i, country: ['cu'], years: [1977, 2030],
  },
  {
    id: 'editorial-gente-nueva',
    search: ['Gente Nueva', 'Editorial Gente Nueva'],
    match: /^[\s\["“”«»'(]*((editorial\s+)?gente\s+nueva)[\s\]"“”«»'),.;:]*$/i,
    place: /habana|havana|cuba/i, country: ['cu'], years: [1967, 2030],
  },
  {
    id: 'editorial-pueblo-y-educacion',
    search: ['Pueblo y Educación', 'Editorial Pueblo y Educación'],
    match: /^[\s\["“”«»'(]*((editorial\s+)?pueblo\s+y\s+educaci[óo]n)[\s\]"“”«»'),.;:]*$/i,
    place: /habana|havana|cuba/i, country: ['cu'], years: [1971, 2030],
  },
  {
    id: 'casa-de-las-americas',
    search: ['Casa de las Américas'],
    match: /^[\s\["“”«»'(]*((ediciones\s+|fondo\s+editorial\s+)?casa\s+de\s+las\s+am[ée]ricas)[\s\]"“”«»'),.;:]*$/i,
    place: /habana|havana|cuba/i, country: ['cu'], years: [1959, 2030],
  },
  {
    id: 'ediciones-union',
    search: ['Ediciones Unión', 'Ediciones UNEAC'],
    match: /^[\s\["“”«»'(]*((ediciones\s+)?uni[óo]n|ediciones\s+uneac|uneac)[\s\]"“”«»'),.;:]*$/i,
    place: /habana|havana|cuba/i, country: ['cu'], years: [1962, 2030],
  },
  {
    id: 'editora-abril',
    search: ['Editora Abril', 'Casa Editora Abril'],
    match: /^[\s\["“”«»'(]*((casa\s+)?editora\s+abril)[\s\]"“”«»'),.;:]*$/i,
    place: /habana|havana|cuba/i, country: ['cu'], years: [1962, 2030],
  },
  {
    id: 'editorial-oriente',
    search: ['Editorial Oriente'],
    match: /^[\s\["“”«»'(]*((editorial\s+)?oriente)[\s\]"“”«»'),.;:]*$/i,
    place: /santiago\s+de\s+cuba/i, country: ['cu'], years: [1971, 2030],
  },
  {
    id: 'editorial-jose-marti',
    search: ['Editorial José Martí'],
    match: /^[\s\["“”«»'(]*((editorial\s+|ediciones\s+en\s+lenguas\s+extranjeras\s+)?jos[ée]\s+mart[íi](\s+publishing\s+house)?)[\s\]"“”«»'),.;:]*$/i,
    place: /habana|havana|cuba/i, country: ['cu'], years: [1983, 2030],
  },
  // The state book institutes of the People's Republics of Mozambique and Angola, which shared a name.
  {
    id: 'inld-mozambique',
    search: ['Instituto Nacional do Livro e do Disco'],
    match: /^[\s\["“”«»'(]*(instituto\s+nacional\s+do\s+livro\s+e\s+do\s+disco|inld)[\s\]"“”«»'),.;:]*$/i,
    place: /maputo|mo[cç]ambique|mozambique/i, country: ['mz'], years: [1975, 1994],
  },
  {
    id: 'inald-angola',
    search: ['Instituto Nacional do Livro e do Disco'],
    match: /^[\s\["“”«»'(]*(instituto\s+nacional\s+do\s+livro\s+e\s+do\s+disco|inald)[\s\]"“”«»'),.;:]*$/i,
    place: /luanda|angola/i, country: ['ao'], years: [1975, 1994],
  },
  {
    id: 'casa-editorial-verde-olivo',
    search: ["Casa Editorial Verde Olivo","Editorial Verde Olivo"],
    match: /^[\s\["“”«»'(]*((casa\s+)?editorial\s+verde\s+olivo)[\s\]"“”«»'),.;:]*$/i,
    place: /habana|havana/i, country: ["cu"], years: [1959,2030],
  },
  {
    id: 'ediciones-sociales-habana',
    search: ["Ediciones Sociales"],
    match: /^[\s\["“”«»'(]*(ediciones\s+sociales)[\s\]"“”«»'),.;:]*$/i,
    place: /habana|havana/i, country: ["cu"], years: [1938,1962],
  },
  {
    id: 'editorial-paginas',
    search: ["Editorial Páginas"],
    match: /^[\s\["“”«»'(]*(editorial\s+p[áa]ginas)[\s\]"“”«»'),.;:]*$/i,
    place: /habana|havana/i, country: ["cu"], years: [1936,1962],
  },
  {
    id: 'hebei-peoples-publishing-house',
    search: ["Hebei ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Hebei\s*ren\s*min\s*chu\s*ban\s*she|河北人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /shijiazhuang|baoding|tianjin|河北/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'shanxi-peoples-publishing-house',
    search: ["Shanxi ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Shanxi\s*ren\s*min\s*chu\s*ban\s*she|山西人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /taiyuan|山西/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'inner-mongolia-peoples-publishing-house',
    search: ["Nei Menggu ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Nei\s*Menggu\s*ren\s*min\s*chu\s*ban\s*she|内蒙古人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /huhehaote|hohhot|huhhot|内蒙古/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'liaoning-peoples-publishing-house',
    search: ["Liaoning ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Liaoning\s*ren\s*min\s*chu\s*ban\s*she|辽宁人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /shenyang|shengyang|辽宁/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'jilin-peoples-publishing-house',
    search: ["Jilin ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Jilin\s*ren\s*min\s*chu\s*ban\s*she|吉林人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /changchun|吉林/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'heilongjiang-peoples-publishing-house',
    search: ["Heilongjiang ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Heilongjiang\s*ren\s*min\s*chu\s*ban\s*she|黑龙江人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /ha.?erbin|harbin|黑龙江/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'jiangsu-peoples-publishing-house',
    search: ["Jiangsu ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Jiangsu\s*ren\s*min\s*chu\s*ban\s*she|江苏人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /nanjing|江苏/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'zhejiang-peoples-publishing-house',
    search: ["Zhejiang ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Zhejiang\s*ren\s*min\s*chu\s*ban\s*she|浙江人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /hangzhou|浙江/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'anhui-peoples-publishing-house',
    search: ["Anhui ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Anhui\s*ren\s*min\s*chu\s*ban\s*she|安徽人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /hefei|安徽/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'fujian-peoples-publishing-house',
    search: ["Fujian ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Fujian\s*ren\s*min\s*chu\s*ban\s*she|福建人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /fuzhou|福建/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'jiangxi-peoples-publishing-house',
    search: ["Jiangxi ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Jiangxi\s*ren\s*min\s*chu\s*ban\s*she|江西人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /nanchang|江西/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'shandong-peoples-publishing-house',
    search: ["Shandong ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Shandong\s*ren\s*min\s*chu\s*ban\s*she|山东人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /ji.?nan|山东/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'henan-peoples-publishing-house',
    search: ["Henan ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Henan\s*ren\s*min\s*chu\s*ban\s*she|河南人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /zhengzhou|kaifeng|河南/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'hubei-peoples-publishing-house',
    search: ["Hubei ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Hubei\s*ren\s*min\s*chu\s*ban\s*she|湖北人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /wuhan|湖北/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'hunan-peoples-publishing-house',
    search: ["Hunan ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Hunan\s*ren\s*min\s*chu\s*ban\s*she|湖南人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /changsha|湖南/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'guangdong-peoples-publishing-house',
    search: ["Guangdong ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Guangdong\s*ren\s*min\s*chu\s*ban\s*she|广东人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /guangzhou|canton|广东/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'guangxi-peoples-publishing-house',
    search: ["Guangxi ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Guangxi\s*ren\s*min\s*chu\s*ban\s*she|广西人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /nanning|广西/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'sichuan-peoples-publishing-house',
    search: ["Sichuan ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Sichuan\s*ren\s*min\s*chu\s*ban\s*she|四川人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /chengdu|四川/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'guizhou-peoples-publishing-house',
    search: ["Guizhou ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Guizhou\s*ren\s*min\s*chu\s*ban\s*she|贵州人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /guiyang|贵州/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'yunnan-peoples-publishing-house',
    search: ["Yunnan ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Yunnan\s*ren\s*min\s*chu\s*ban\s*she|云南人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /kunming|云南/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'tibet-peoples-publishing-house',
    search: ["Xizang ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Xizang\s*ren\s*min\s*chu\s*ban\s*she|西藏人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /lasa|lhasa|西藏/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'shaanxi-peoples-publishing-house',
    search: ["Shaanxi ren min chu ban she"],
    // Often romanised "Shanxi", like the neighbouring province; the place (Xi'an) decides.
    match: /^[\s\["“”«»'(]*(Sha?anxi\s*ren\s*min\s*chu\s*ban\s*she|陕西人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /xi.?an|陕西/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'gansu-peoples-publishing-house',
    search: ["Gansu ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Gansu\s*ren\s*min\s*chu\s*ban\s*she|甘肃人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /lanzhou|甘肃/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'qinghai-peoples-publishing-house',
    search: ["Qinghai ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Qinghai\s*ren\s*min\s*chu\s*ban\s*she|青海人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /xining|青海/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'ningxia-peoples-publishing-house',
    search: ["Ningxia ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Ningxia\s*ren\s*min\s*chu\s*ban\s*she|宁夏人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /yinchuan|宁夏/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'xinjiang-peoples-publishing-house',
    search: ["Xinjiang ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Xinjiang\s*ren\s*min\s*chu\s*ban\s*she|新疆人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /wulumuqi|urumqi|ürümqi|新疆/i, country: ["cc"], years: [1949,1990],
  },
  {
    id: 'beijing-peoples-publishing-house',
    search: ["Beijing ren min chu ban she"],
    match: /^[\s\["“”«»'(]*(Beijing\s*ren\s*min\s*chu\s*ban\s*she|北京人民出版社)[\s\]"“”«»'),.;:]*$/i,
    place: /beijing|peking|北京/i, country: ["cc"], years: [1949,1990],
  },

  // --- Ninth round: small socialist presses of the Russian Empire and of interwar Eastern Europe
  {
    id: 'vpered',
    search: ["Vpered"],
    match: /^[\s\["“”«»'(]*((kn(-vo|igoizdatelʹstvo)\s+|izd(-vo|\.)\s+)?["“«]?vper[eë]d["”»]?)[\s\]"“”«»'),.;:]*$/i,
    place: /zhenev|geneva|gen[èe]ve|genf|peterburg|petersburg/i, country: ["sz","ru"], years: [1904,1907],
  },
  {
    id: 'zerno',
    search: ["Zerno"],
    match: /^[\s\["“”«»'(]*((kn(-vo|igoizdatelʹstvo)\s+|izd(-vo|\.)\s+)?["“«]?zerno["”»]?)[\s\]"“”«»'),.;:]*$/i,
    place: /peterburg|petersburg|spb/i, country: ["ru"], years: [1906,1908],
  },
  {
    id: 'nachalo',
    search: ["Nachalo"],
    match: /^[\s\["“”«»'(]*((kn(-vo|igoizdatelʹstvo)\s+|izdatelʹstvo\s+zhurnala\s+)?["“«]?nachalo["”»]?)[\s\]"“”«»'),.;:]*$/i,
    place: /peterburg|petersburg|spb/i, country: ["ru"], years: [1899,1907],
  },
  {
    id: 'komunisticke-nakladatelstvi',
    search: ["Komunistické nakladatelství a knihkupectví","Komunistické knihkupectví a nakladatelství"],
    match: /^[\s\["“”«»'(]*((vydalo\s+)?komunistick[ée]\s+(nakladatelstv[íi]\s+a\s+knihkupectv[íi]|knihkupectv[íi]\s+a\s+nakladatelstv[íi]).*)[\s\]"“”«»'),.;:]*$/i,
    place: /praha|praze|prague/i, country: ["xr","cs"], years: [1920,1938],
  },
  {
    id: 'partiina-sotsialisticheska-knizharnitsa',
    search: ["Partiĭna sotsialisticheska knizharnitsa"],
    match: /^[\s\["“”«»'(]*(parti[ĭi]na\s+sot\S*ialist\S*\s+knizharnit\S*(\s+i\s+pe\S*atnit\S*)?)[\s\]"“”«»'),.;:]*$/i,
    place: /sofi/i, country: ["bu"], years: [1903,1920],
  },
  {
    id: 'robotnik-pps',
    search: ["Robotnik","Spółka Nakładowo-Wydawnicza Robotnik"],
    match: /^[\s\["“”«»'(]*((nak[łl](adem|\.)\s+)?(sp[óo][łl]ki\s+nak[łl](adowo|\.)[-\s]+wydawn\S*\s+)?(grupy\s+politycznej\s+)?["“«]?robotnik["”»]?)[\s\]"“”«»'),.;:]*$/i,
    place: /warsz|warsaw|london|krak[óo]w|[łl][óo]d[źz]/i, country: ["pl","enk"], years: [1894,1939],
  },
  {
    id: 'remarques-congolaises',
    search: ['Remarques congolaises', 'Remarques africaines'],
    match: /^[\s\["“”«»'(]*((éditions\s+|editions\s+)?remarques\s+(congolaises|africaines))[\s\]"“”«»'),.;:]*$/i,
    place: /bruxelles|brussels|kinshasa/i, country: ['be'], years: [1959, 1980],
  },
  {
    id: 'patriotic-front-of-thailand',
    search: ['Patriotic Front of Thailand'],
    match: /^[\s\["“”«»'(]*((the\s+)?(office\s+of\s+the\s+representative\s+abroad\s+of\s+the\s+)?(thailand\s+patriotic\s+front|patriotic\s+front\s+of\s+thailand))[\s\]"“”«»'),.;:]*$/i,
    place: /./, country: ['cc', 'th', 'xx'], years: [1965, 1983],
    allowNoPlace: true,
  },

  // --- Tenth round: presses missing against marxists.org, and the Bahamas
  {
    id: 'appeal-to-reason',
    search: ["Appeal to Reason"],
    match: /^[\s\["“”«»'(]*((the\s+|press\s+of\s+the\s+|printed\s+by\s+)?appeal\s+to\s+reason)[\s\]"“”«»'),.;:]*$/i,
    place: /girard/i, country: ["ksu","xxu"], years: [1895,1922],
  },
  {
    id: 'clarion-press',
    search: ["Clarion Newspaper Company","Clarion Press"],
    match: /^[\s\["“”«»'(]*((the\s+)?["“]?clarion["”]?\s+(newspaper\s+co(mpany|\.)?(,?\s+(ltd\.?|limited))?|press))[\s\]"“”«»'),.;:]*$/i,
    place: /london|manchester/i, country: ["enk","xxk"], years: [1891,1934],
  },
  {
    id: 'russian-free-press-fund',
    search: ["Russian Free Press Fund"],
    match: /^[\s\["“”«»'(]*((printed\s+by\s+the\s+)?["“]?russian\s+free\s+press\s+fund["”]?)[\s\]"“”«»'),.;:]*$/i,
    place: /london/i, country: ["enk","xxk"], years: [1891,1917],
  },
  {
    id: 'socialist-league',
    search: ["Socialist League","Socialist League Office"],
    match: /^[\s\["“”«»'(]*((the\s+)?socialist\s+league(\s+office)?|office\s+of\s+(the\s+)?["“]?commonweal["”]?)[\s\]"“”«»'),.;:]*$/i,
    place: /london/i, country: ["enk","xxk"], years: [1885,1901],
  },
  {
    id: 'spartacist-publishing',
    search: ["Spartacist Publishing Co."],
    match: /^[\s\["“”«»'(]*(spartacist\s+publishing\s+co(mpany|\.)?)[\s\]"“”«»'),.;:]*$/i,
    place: /new\s*york|usa/i, country: ["nyu","xxu"], years: [1964,2030],
  },
  {
    id: 'vanguard-nationalist-and-socialist-party',
    search: ["Vanguard Nationalist and Socialist Party"],
    match: /^[\s\["“”«»'(]*(vanguard\s+nationalist\s+and\s+socialist\s+party(\s+of\s+the\s+bahamas)?)[\s\]"“”«»'),.;:]*$/i,
    place: /nassau|bahamas/i, country: ["bf"], years: [1971,2000],
    allowNoPlace: true,
  },

  // --- Eleventh round: communist publishers of Algeria and Tunisia
  {
    id: 'parti-communiste-algerien',
    search: ["Parti communiste algérien"],
    // "le Parti communiste algérien (impr. de Koechlin)", "Impr. spéciale du …", "Comité central du …"
    match: /^[\s\["“”«»'(]*((le\s+)?(comit[ée]\s+central\s+du\s+)?(impr(\.|imerie)\s+(sp[ée]ciale\s+)?du\s+)?parti\s+communiste\s+alg[ée]rien(\s+\(p\.?\s*c\.?\s*a\.?\))?(\s*\(\s*impr[^)]*\))?)[\s\]"“”«»'),.;:]*$/i,
    // "S.l." (no place stated) appears on its clandestine wartime pamphlets.
    place: /alger|algiers|oran|constantine|paris|s\.\s*l\./i, country: ["ae","fr"], years: [1936,1965],
  },
  {
    id: 'alger-republicain',
    search: ["Alger républicain"],
    // "Editions "Alger républicain"", "Éditions d'"Alger républicain"", "Édition Alger républicain"
    match: /^[\s\["“”«»'(]*([ée]ditions?\s+(d['’])?)?["“«]?alger[-\s]r[ée]publicain["”»]?(\s*\(\s*impr[^)]*\))?[\s\]"“”«»'),.;:]*$/i,
    place: /alger|algiers/i, country: ["ae"], years: [1938,1994],
  },
  {
    id: 'pags',
    search: ["Parti de l'avant-garde socialiste","PAGS"],
    match: /^[\s\["“”«»'(]*(p\.?\s*a\.?\s*g\.?\s*s\.?|parti\s+de\s+l['’]avant[-\s]garde\s+socialiste|[ḥh]izb\s+al[-\s][ṭt]al[īi][ʻ']ah\s+al[-\s]ishtir[āa]k[īi]yah(\s+al[-\s]jaz[āa]ʼir[īi]yah)?)[\s\]"“”«»'),.;:]*$/i,
    place: /alger|algiers|al-jaz/i, country: ["ae"], years: [1966,1993],
  },
  {
    id: 'parti-communiste-tunisien',
    search: ["Parti communiste tunisien"],
    match: /^[\s\["“”«»'(]*(parti\s+communiste\s+tunisien)[\s\]"“”«»'),.;:]*$/i,
    place: /tunis|paris/i, country: ["ti","fr"], years: [1934,1993],
  },
  {
    id: 'perspectives-tunisiennes',
    search: ["Groupe d'études et d'action socialiste tunisien"],
    match: /^[\s\["“”«»'(]*(groupe\s+d['’][ée]tudes\s+et\s+d['’]action\s+socialiste\s+tunisien)[\s\]"“”«»'),.;:]*$/i,
    place: /paris|tunis/i, country: ["fr","ti"], years: [1963,1975],
  },
  {
    id: 'pdois',
    search: ['PDOIS', 'Foroyaa', "People's Democratic Organisation for Independence and Socialism"],
    match: /^[\s\["“”«»'(]*(p\.?\s*d\.?\s*o\.?\s*i\.?\s*s\.?(['’]?\s+editorial\s+board)?|foroyaa(\s+press)?|people['’]?s\s+democratic\s+organi[sz]ation\s+for\s+independence\s+and\s+socialism)[\s\]"“”«»'),.;:]*$/i,
    place: /serrekunda|gambia|banjul|bakau/i, country: ['ga'], years: [1986, 2030],
    allowNoPlace: true,
  },

  // --- Twelfth round: Vietnamese and Korean communist presses before the revolutions, and the
  // Librairie du Travail
  {
    id: 'dan-chung',
    search: ["Dân chúng"],
    match: /^[\s\["“”«»'(]*((b[áa]o\s+)?d[âa]n[-\s]ch[úu]ng)[\s\]"“”«»'),.;:]*$/i,
    place: /s[àa]i[-\s]?g[òo]n|saigon|h[àa][\s-]*n[ộọo]i|hanoi/i, country: ["vm"], years: [1936,1941],
  },
  {
    id: 'la-lutte-saigon',
    search: ["La Lutte"],
    match: /^[\s\["“”«»'(]*((éditions\s+de\s+)?la\s+lutte)[\s\]"“”«»'),.;:]*$/i,
    place: /s[àa]i[-\s]?g[òo]n|saigon|cholon/i, country: ["vm"], years: [1933,1940],
  },
  {
    id: 'librairie-du-travail',
    search: ["Librairie du Travail","Librairie du travail"],
    match: /^[\s\["“”«»'(]*((la\s+)?librairie\s+du\s+travail)[\s\]"“”«»'),.;:]*$/i,
    place: /paris/i, country: ["fr"], years: [1916,1940],
  },
  {
    id: 'communist-party-of-korea-north-korean-bureau',
    search: ["Chosŏn Kongsandang Puk Chosŏn Punʼguk"],
    match: /^[\s\["“”«»'(]*(chos[ŏo]n\s+kongsandang\s+puk\s*chos[ŏo]n\s+pun[ʼ']?guk(\s+s[ŏo]nj[ŏo]nbu)?)[\s\]"“”«»'),.;:]*$/i,
    place: /p.?y[ŏo]ngyang/i, country: ["kn","ko"], years: [1945,1946],
    allowNoPlace: true,
  },

  // --- Thirteenth round: anticolonial and anti-imperialist movements that espoused communism
  {
    id: 'mpla',
    search: ["MPLA","Movimento Popular de Libertação de Angola"],
    match: /^[\s\["“”«»'(]*(mpla(\s*[-–,]\s*partido\s+d[eo]\s+trabalho)?|movimento\s+popular\s+de\s+liberta[çc]̦?[ãa]o\s+de\s+angola)[\s\]"“”«»'),.;:]*$/i,
    place: /luanda|lusaka|angola|brazzaville|dar\s+es\s+salaam/i, country: ["ao","za","cf"], years: [1956,1992],
    allowNoPlace: true,
  },
  {
    id: 'zapu',
    search: ["ZAPU","Zimbabwe African People's Union"],
    match: /^[\s\["“”«»'(]*(zapu(\s+publications)?|patriotic\s+front,?\s+zapu|anc[-\s]zapu|((national\s+publicity\s+bureau\s+of\s+the|information\s+and\s+publicity\s+dep(t|artment)\.?,?)\s+)?zimbabwe\s+african\s+peoples?['’]?\s+union(\s+\(zapu\))?)[\s\]"“”«»'),.;:]*$/i,
    place: /lusaka|zambia|cairo|salisbury|harare|bulawayo/i, country: ["za","ua","rh"], years: [1961,1987],
    allowNoPlace: true,
  },
  {
    id: 'tupamaros',
    search: ["Tupamaros","MLN-Tupamaros"],
    match: /^[\s\["“”«»'(]*((movimiento\s+de\s+liberaci[óo]n\s+nacional[\s,–-]+tupamaros|mln[\s–-]+tupamaros|tupamaros)(,?\s+propaganda\s+central)?)[\s\]"“”«»'),.;:]*$/i,
    place: /montevideo|uruguay/i, country: ["uy"], years: [1962,1995],
    allowNoPlace: true,
  },
  {
    id: 'partido-comunista-del-peru',
    search: ["Partido Comunista del Perú"],
    match: /^[\s\["“”«»'(]*(partido\s+comunista\s+del\s+per[úu])[\s\]"“”«»'),.;:]*$/i,
    place: /lima|per[úu]|s\.\s*l\./i, country: ["pe"], years: [1964,2000],
    allowNoPlace: true,
  },
  {
    id: 'committee-to-support-the-revolution-in-peru',
    search: ["Committee to Support the Revolution in Peru"],
    match: /^[\s\["“”«»'(]*((the\s+)?committee\s+to\s+support\s+the\s+revolution\s+in\s+peru)[\s\]"“”«»'),.;:]*$/i,
    place: /berkeley|california|calif/i, country: ["cau","xxu"], years: [1983,2010],
    allowNoPlace: true,
  },
  {
    id: 'fsln',
    search: ["Frente Sandinista de Liberación Nacional"],
    match: /^[\s\["“”«»'(]*((comisi[óo]n\s+(exterior|de\s+informaci[óo]n)[^,]*,?\s+(de\s+la\s+representaci[óo]n\s+en\s+cuba,?\s+)?del\s+)?frente\s+sandinista\s+de\s+liberaci[óo]n\s+nacional(,?\s+secretar[íi]a\s+nacional\s+de\s+propaganda\s+y\s+educaci[óo]n\s+pol[íi]tica)?)[\s\]"“”«»'),.;:]*$/i,
    place: /managua|nicaragua|habana|havana/i, country: ["nq","cu"], years: [1961,1995],
    allowNoPlace: true,
  },
  {
    id: 'wesanen-serxwebun',
    search: ["Weşanên Serxwebûn"],
    match: /^[\s\["“”«»'(]*((we[şs]an[êe]n\s+)?serxweb[ûu]n)[\s\]"“”«»'),.;:]*$/i,
    place: /k[öo]ln|cologne|germany|neuss|istanbul|s\.\s*l\./i, country: ["gw","tu"], years: [1978,2030],
    allowNoPlace: true,
  },

  // --- Fourteenth round: the communist internationals' own presses (listed on the International page)
  {
    id: 'publishing-house-of-the-communist-international',
    search: ["Communist International","Kommunistische Internationale","Internationale communiste","Executive Committee of the Communist International"],
    match: /^[\s\["“”«»'(]*((published\s+by\s+the\s+)?(executive\s+committee\s+of\s+the\s+)?communist\s+international|(verlag\s+der\s+)?kommunistische[nr]?\s+internationale(\s*;?\s*auslieferungsstelle.*)?|([ée]ditions?\s+de\s+l['’]\s*)?internationale\s+communiste|kommunisticheski[ĭi]\S*\s+internat\S*)[\s\]"“”«»'),.;:!]*$/i,
    place: /p[ée]trograd|petersburg|moscow|moskva|moskau|moscou/i, country: ["ru","ur","xxr"], years: [1919,1925],
    allowNoPlace: true,
  },
  {
    id: 'red-international-of-labour-unions-press',
    search: ["Red International of Labour Unions","Red International of Labor Unions"],
    match: /^[\s\["“”«»'(]*((published\s+for\s+the\s+)?(british\s+bureau,?\s+)?red\s+international\s+(of|&)\s+labou?r\s+unions?|r\.\s*i\.\s*l\.\s*u\.?)[\s\]"“”«»'),.;:!]*$/i,
    place: /london|moscow/i, country: ["enk","xxk","ru","ur"], years: [1921,1937],
    allowNoPlace: true,
  },
  {
    id: 'publishing-house-of-the-young-communist-international',
    search: ["Young Communist International","Verlag der Jugendinternationale","Jugendinternationale"],
    match: /^[\s\["“”«»'(]*((international\s+)?publishing\s+house\s+of\s+the\s+young\s+(communist\s+)?international(\s*\/.*)?|(executive\s+committee,?\s+(of\s+the\s+)?)?young\s+communist\s+international(,?\s+c\/o.*)?|verlag\s+der\s+jugend[-\s]?internationale|internationaler\s+jugend[-\s]?verlag)[\s\]"“”«»'),.;:!]*$/i,
    place: /berlin|sch[öo]neberg|london|moscow|moskau|wien/i, country: ["gw","enk","xxk","ru","au"], years: [1919,1943],
    allowNoPlace: true,
  },
  {
    id: 'mopr-verlag',
    search: ["Mopr Verlag","MOPR","International Red Aid"],
    match: /^[\s\["“”«»'(]*(mopr[-\s]?verlag|(publishing\s+department\s+of\s+the\s+)?executive\s+committee\s+of\s+(the\s+)?(i\.\s*r\.\s*a\.?|international\s+red\s+aid)|izd[-\s]*vo\s+t\W*s\W*k\W*\s*mopr(\s+sssr)?)[\s\]"“”«»'),.;:!]*$/i,
    place: /berlin|moscow|moskva|moskau/i, country: ["gw","ru","ur"], years: [1923,1937],
    allowNoPlace: true,
  },
  {
    id: 'for-a-lasting-peace',
    search: ["For a Lasting Peace, for a People's Democracy"],
    match: /^[\s\["“”«»'(]*((the\s+journal\s+)?["“]?for\s+a\s+lasting\s+peace,?\s+for\s+a\s+people['’]?s\s+democracy!?["”]?)[\s\]"“”«»'),.;:!]*$/i,
    place: /bucharest|bucure[şs]ti|belgrade|beograd|hungary/i, country: ["rm","yu","hu","xx"], years: [1947,1956],
    allowNoPlace: true,
  },
  {
    id: 'peace-and-socialism-publishers',
    search: ["Peace and Socialism"],
    match: /^[\s\["“”«»'(]*(peace\s+and\s+socialism(\s+international)?(\s+publish(ers|ing\s+house))?(,?\s+t\.\s+rud[ée]\s+pr[aá]vo)?(\s*\/\s*peace\s+and\s+socialism.*)?)[\s\]"“”«»'),.;:!]*$/i,
    place: /prague|praha|prag/i, country: ["cs","xr"], years: [1958,1990],
    allowNoPlace: true,
  },

  // --- Fifteenth round: Puerto Rico's Marxist presses (pinned on Puerto Rico, filed under the United States)
  {
    id: 'partido-socialista-puertorriqueno',
    search: ["Partido Socialista Puertorriqueño","Movimiento Pro Independencia"],
    // Its weekly Claridad's imprint in San Juan (the place rule keeps out Buenos Aires's Editorial Claridad).
    match: /^[\s\["“”«»'(]*((comit[ée]\s+central,?\s+)?partido\s+socialista\s+puertorrique[ñn]o|(misi[óo]n\s+nacional\s+albizu\s+campos\s+del\s+)?movimiento\s+pro[-\s]+independencia(\s+de\s+puerto\s+rico)?|(editorial\s+)?claridad)[\s\]"“”«»'),.;:!]*$/i,
    place: /puerto\s+rico|san\s+juan|r[íi]o\s+piedras|santurce|s\.\s*l\.|new\s+york/i, country: ["pr","nyu"], years: [1959,1993],
  },
  {
    id: 'liga-socialista-puertorriquena',
    search: ["Liga Socialista Puertorriqueña"],
    match: /^[\s\["“”«»'(]*((cuadros\s+estudiantiles\s+de\s+la\s+)?liga\s+socialista\s+puertorrique[ñn]a)[\s\]"“”«»'),.;:!]*$/i,
    place: /puerto\s+rico|san\s+juan|santurce|guaynabo|ciales|r[íi]o\s+piedras/i, country: ["pr"], years: [1964,2000],
    allowNoPlace: true,
  },
  {
    id: 'movimiento-socialista-de-trabajadores',
    search: ["Movimiento Socialista de Trabajadores"],
    match: /^[\s\["“”«»'(]*(movimiento\s+socialista\s+de\s+trabajadores)[\s\]"“”«»'),.;:!]*$/i,
    place: /puerto\s+rico|san\s+juan|r[íi]o\s+piedras/i, country: ["pr"], years: [1982,2005],
    allowNoPlace: true,
  },
  {
    id: 'taller-de-formacion-politica',
    search: ["Taller de Formación Política"],
    match: /^[\s\["“”«»'(]*(taller\s+de\s+formaci[óo]n\s+pol[íi]tica)[\s\]"“”«»'),.;:!]*$/i,
    place: /puerto\s+rico|san\s+juan|r[íi]o\s+piedras/i, country: ["pr"], years: [1980,2005],
    allowNoPlace: true,
  },

  // --- Sixteenth round: the Soviet republics' State Publishing Houses, and pre-revolutionary and émigré presses of their movements
  {
    id: 'derzhavne-vydavnytstvo-ukrainy',
    search: ["Derzhavne vydavnytstvo Ukrainy","Derzhavne vydavnyt͡stvo Ukraïny","Державне видавництво України"],
    match: /^[\s\["“”«»'(]*(derzh\S*\s+vydavn\S*\s+ukra\S*|державне\s+видавництво\s+україни|dvu)[\s\]"“”«»'),.;:!]*$/i,
    place: /khar\S*kiv|khar\S*kov|ky[ïi]v|kiev|odes|kateryno/i, country: ["un","ur","xxr"], years: [1919,1931],
  },
  {
    id: 'proletarii-kharkiv',
    search: ["Proletariĭ","Proletarii"],
    match: /^[\s\["“”«»'(]*((izd(-vo|atel\S*)\s+)?["“«]?proletari[ĭiy]["”»]?)[\s\]"“”«»'),.;:!]*$/i,
    place: /khar\S*kiv|khar\S*kov/i, country: ["un","ur"], years: [1921,1932],
  },
  {
    id: 'partvydav-ukrainy',
    search: ["Partvydav"],
    match: /^[\s\["“”«»'(]*(partvydav(\s+["“]?proletar["”]?)?(\s+t\W*s\W*k\s+kp\s*\(b\)\s*u)?)[\s\]"“”«»'),.;:!]*$/i,
    place: /khar\S*kiv|khar\S*kov|ky[ïi]v|kiev/i, country: ["un","ur"], years: [1930,1956],
  },
  {
    id: 'ukrainskyi-robitnyk',
    search: ["Ukraïnsʹkyĭ robitnyk"],
    match: /^[\s\["“”«»'(]*(ukra[ïi]ns[ʹ'’]?ky[ĭi]\s+robitnyk|український\s+робітник)[\s\]"“”«»'),.;:!]*$/i,
    place: /khar\S*kiv|khar\S*kov/i, country: ["un","ur"], years: [1923,1935],
  },
  {
    id: 'belaruskae-dziarzhaunae-vydavetstva',
    search: ["Belaruskae dzi͡arzhaŭnae vydavet͡stva","Dzi͡arzhaŭnae vydavet͡stva Belarusi"],
    match: /^[\s\["“”«»'(]*((belaruskae\s+)?dz\W*i\W*a\W*r\W*z\W*h\W*a\W*[uŭ]\W*nae\s+vydavet\W*s\W*tva(\s+belarusi)?(,\s*.*)?|беларускае\s+дзяржаўнае\s+выдавецтва|belgosizdat)[\s\]"“”«»'),.;:!]*$/i,
    place: /mensk|minsk|менск|мінск/i, country: ["bw","ur"], years: [1921,1941],
  },
  {
    id: 'sakhelgami',
    search: ["Sakhelgami"],
    match: /^[\s\["“”«»'(]*(sakhelgami|სახელგამი)[\s\]"“”«»'),.;:!]*$/i,
    place: /t[ʻ']?bilisi|tiflis/i, country: ["gs","ur"], years: [1921,1960],
  },
  {
    id: 'haypethrat',
    search: ["Haypethrat","Hayastani petakan hratarakchʻutʻyun","Petakan hratarakchʻutʻyun"],
    match: /^[\s\["“”«»'(]*(["“]?haypethrat["”]?|(hayastani\s+)?petakan\s+hratarakch\S*|հայպետհրատ)[\s\]"“”«»'),.;:!]*$/i,
    place: /erevan|yerevan|երևան|ереван/i, country: ["ai","ur"], years: [1921,1964],
  },
  {
    id: 'azgiz',
    search: ["Azgiz"],
    match: /^[\s\["“”«»'(]*(az(go)?giz|az(go)?sizdat)[\s\]"“”«»'),.;:!]*$/i,
    place: /baku|bak[ʻ']?u|баку/i, country: ["aj","ur"], years: [1922,1940],
  },
  {
    id: 'uzgiz',
    search: ["Uzgiz"],
    match: /^[\s\["“”«»'(]*(uz(go)?giz|ŭzdavnashr)[\s\]"“”«»'),.;:!]*$/i,
    place: /tashkent|toshkent|samarkand|samarqand/i, country: ["uz","ur"], years: [1924,1945],
  },
  {
    id: 'kazgiz',
    search: ["Kazgiz","Kazakhskoe gosudarstvennoe izdatelʹstvo"],
    match: /^[\s\["“”«»'(]*((tip\.\s+no\.\s*\d+\s+)?kazgiz['’]?a?|kazakhskoe\s+(gosudarstvennoe\s+)?izdatel\S*(\s+(politicheskoi|khudozhestvennoi)\s+literatury)?)[\s\]"“”«»'),.;:!]*$/i,
    place: /alma-?ata|almaty|kzyl-?orda|tashkent|moskva|moscow/i, country: ["kz","ur"], years: [1924,1964],
  },
  {
    id: 'turkmengosizdat',
    search: ["Turkmengosizdat"],
    match: /^[\s\["“”«»'(]*(turkmen(go)?s?izdat|turkmengiz)[\s\]"“”«»'),.;:!]*$/i,
    place: /ashkhaba[dt]|ashgabat|askhabad|poltoratsk/i, country: ["tk","ur"], years: [1926,1966],
  },
  {
    id: 'tadzhikgosizdat',
    search: ["Tadzhikgosizdat"],
    match: /^[\s\["“”«»'(]*(tadzhik(go)?s?izdat|nashri[eë]ti\s+davlatii\s+toj\S*)[\s\]"“”«»'),.;:!]*$/i,
    place: /stalinabad|dushanbe/i, country: ["ta","ur"], years: [1929,1966],
  },
  {
    id: 'kirgizgosizdat',
    search: ["Kirgizgosizdat"],
    match: /^[\s\["“”«»'(]*(kirgiz(go)?s?izdat|kyrgyzmambas)[\s\]"“”«»'),.;:!]*$/i,
    place: /frunze|bishkek|pishpek/i, country: ["kg","ur"], years: [1926,1970],
  },
  {
    id: 'social-democrat-hunchakian-party',
    search: ["Hnchʻakean","Hnchak"],
    // Also its American district's imprint: "Hrat. Sotsʻ. Dēm. Hnchʻ. Kus. Amer.-i Shrjani" (Providence).
    match: /^[\s\["“”«»'(]*((hratarakut\S*\s+)?(s\.\s*-?\s*d\.\s*|sots\S*\s+demokrat\s+)hnch\S*\s+kus\S*(\s+.*)?|hrat\.?\s+sots\S*\s+d[ēe]m\S*\s+hnch\S*\s+kus\S*.*|tparan\s+["“]?hnch\S*["”]?)[\s\]"“”«»'),.;:!]*$/i,
    place: /gen[eè]v|jenev|london|pari[sz]|istanbul|kostandnupol|peyrut|beirut|athens|cairo|p[ʻ']?rovit[ēe]ns|providence|boston/i, country: ["sz","enk","fr","tu","le","riu","mau"], years: [1887,1991],
    allowNoPlace: true,
  },
  {
    id: 'bund-foreign-committee',
    search: ["Bund"],
    match: /^[\s\["“”«»'(]*(bund)[\s\]"“”«»'),.;:!]*$/i,
    place: /gen[eè]v|jenev|london/i, country: ["sz","enk"], years: [1897,1917],
  },
  {
    id: 'prometejs',
    search: ["Prometejs"],
    match: /^[\s\["“”«»'(]*((izdevniec[īi]ba\s+)?["“]?prometejs["”]?|izd(-vo|atel\S*)\s+["“«]?prometei["”»]?)[\s\]"“”«»'),.;:!]*$/i,
    place: /maskav|moskv|moscow|moskau/i, country: ["ru","ur","xxr"], years: [1920,1937],
  },

  // --- Seventeenth round: the United States, Canada and Mexico rechecked
  {
    id: 'charles-h-kerr',
    search: ["Charles H. Kerr"],
    match: /^[\s\["“”«»'(]*((charles|c\.)\s*h\.?\s*kerr(\s*(&|and)\s*(co(mpany|\.)?))?(,?\s+(co-?operative|publishing(\s+co(mpany|\.)?)?|publishers))?)[\s\]"“”«»'),.;:!]*$/i,
    place: /chicago|ill\./i, country: ["ilu"], years: [1886,2030],
    allowNoPlace: true,
  },
  {
    id: 'rand-school-press',
    search: ["Rand School"],
    match: /^[\s\["“”«»'(]*(rand\s+school(\s+of\s+social\s+science)?(\s+press)?|rand\s+book\s+store)[\s\]"“”«»'),.;:!]*$/i,
    place: /new\s*york|n\.\s*y\.|brooklyn/i, country: ["nyu"], years: [1906,1960],
  },
  {
    id: 'daily-worker-publishing-company',
    search: ["Daily Worker Publishing","Workers Party of America"],
    match: /^[\s\["“”«»'(]*(daily\s+worker\s+pub(lishing|\.)?\s+co(mpany|\.)?|(published\s+for\s+the\s+)?workers\s+party\s+of\s+america(,?\s+.*)?|literature\s+department,?\s+workers\s+party(\s+of\s+america)?)[\s\]"“”«»'),.;:!]*$/i,
    place: /chicago|new\s*york|n\.\s*y\./i, country: ["ilu","nyu"], years: [1921,1929],
  },
  {
    id: 'communist-party-usa',
    search: ["Communist Party, U.S.A.","Communist Party of the U.S.A.","National Committee, Communist Party"],
    match: /^[\s\["“”«»'(]*((((national|central)\s+committee|jewish\s+bur(o|eau)\s+of\s+the\s+central\s+committee),?\s+(of\s+the\s+)?)?communist\s+party,?\s+(of\s+the\s+)?u\.?\s*s\.?\s*a\.?|communist\s+party\s+of\s+the\s+united\s+states(\s+of\s+america)?|(published\s+for\s+the\s+)?communist\s+party\s+national\s+(campaign|election)\s+committee|national\s+(campaign\s+)?committee,?\s+communist\s+party)[\s\]"“”«»'),.;:!]*$/i,
    place: /new\s*york|n\.\s*y\.|brooklyn/i, country: ["nyu"], years: [1929,2030],
  },
  {
    id: 'masses-and-mainstream',
    search: ["Masses & Mainstream","Masses and Mainstream"],
    match: /^[\s\["“”«»'(]*(masses\s*(&|and)\s*mainstream(,?\s+inc\.?)?|mainstream\s+publishers)[\s\]"“”«»'),.;:!]*$/i,
    place: /new\s*york|n\.\s*y\.|brooklyn/i, country: ["nyu"], years: [1948,1963],
  },
  {
    id: 'new-outlook-publishers',
    search: ["New Outlook Publishers"],
    match: /^[\s\["“”«»'(]*(new\s+outlook(\s+publishers(\s*(&|and)\s*distributors)?)?)[\s\]"“”«»'),.;:!]*$/i,
    place: /new\s*york|n\.\s*y\.|brooklyn/i, country: ["nyu"], years: [1960,2030],
    allowNoPlace: true,
  },
  {
    id: 'political-affairs-publishers',
    search: ["Political Affairs Publishers"],
    match: /^[\s\["“”«»'(]*(political\s+affairs\s+publishers?)[\s\]"“”«»'),.;:!]*$/i,
    place: /new\s*york|n\.\s*y\.|brooklyn/i, country: ["nyu"], years: [1960,2030],
  },
  {
    id: 'world-view-publishers',
    search: ["World View Publishers","World View Forum","Youth Against War & Fascism"],
    match: /^[\s\["“”«»'(]*(world\s+view\s+(publishers|forum)(\s+pub(lishers|\.)?)?|youth\s+against\s+war\s*(&|and)\s*fascism)[\s\]"“”«»'),.;:!]*$/i,
    place: /new\s*york|n\.\s*y\.|atlanta/i, country: ["nyu","gau"], years: [1959,2030],
    allowNoPlace: true,
  },
  {
    id: 'marxist-educational-press',
    search: ["Marxist Educational Press"],
    match: /^[\s\["“”«»'(]*(marxist\s+educational\s+press|mep\s+pub(lication)?n?s)[\s\]"“”«»'),.;:!]*$/i,
    place: /minneapolis|minn/i, country: ["mnu"], years: [1977,2030],
    allowNoPlace: true,
  },
  {
    id: 'black-panther-party',
    search: ["Black Panther Party"],
    match: /^[\s\["“”«»'(]*((the\s+)?black\s+panther\s+party(,?\s+ministry\s+of\s+information)?|ministry\s+of\s+information,?\s+black\s+panther\s+party)[\s\]"“”«»'),.;:!]*$/i,
    place: /oakland|san\s+francisco|berkeley|calif/i, country: ["cau"], years: [1966,1982],
    allowNoPlace: true,
  },
  {
    id: 'south-end-press',
    search: ["South End Press"],
    match: /^[\s\["“”«»'(]*(south\s+end\s+press)[\s\]"“”«»'),.;:!]*$/i,
    place: /boston|cambridge|brooklyn|mass/i, country: ["mau","nyu"], years: [1977,2014],
    allowNoPlace: true,
  },
  {
    id: 'prometheus-research-library',
    search: ["Prometheus Research Library"],
    match: /^[\s\["“”«»'(]*(prometheus\s+research\s+library)[\s\]"“”«»'),.;:!]*$/i,
    place: /new\s*york|n\.\s*y\.|brooklyn/i, country: ["nyu"], years: [1985,2030],
    allowNoPlace: true,
  },
  {
    id: 'socialist-party-of-america',
    search: ["Socialist Party of America","Socialist Party (U.S.)"],
    match: /^[\s\["“”«»'(]*((national\s+office,?\s+)?socialist\s+party(\s+of\s+america|,?\s+u\.?\s*s\.?\s*a\.?)?(,?\s+national\s+office)?)[\s\]"“”«»'),.;:!]*$/i,
    place: /chicago|new\s*york/i, country: ["ilu","nyu"], years: [1901,1972],
  },
  {
    id: 'line-of-march',
    search: ["Line of March"],
    match: /^[\s\["“”«»'(]*(line\s+of\s+march(\s+publications)?)[\s\]"“”«»'),.;:!]*$/i,
    place: /oakland|san\s+francisco|calif/i, country: ["cau"], years: [1980,1990],
  },
  {
    id: 'communist-party-of-canada',
    search: ["Communist Party of Canada","Labor-Progressive Party"],
    match: /^[\s\["“”«»'(]*((((national|central)\s+(executive\s+)?committee|national\s+committee),?\s+)?(communist\s+party\s+of\s+canada|labou?r[-\s]progressive\s+party))[\s\]"“”«»'),.;:!]*$/i,
    place: /toronto|montr[ée]al|vancouver|winnipeg|ont/i, country: ["onc","quc","bcc","mbc"], years: [1921,2030],
  },
  {
    id: 'vanguard-publications',
    search: ["Vanguard Publications"],
    match: /^[\s\["“”«»'(]*(vanguard\s+publications)[\s\]"“”«»'),.;:!]*$/i,
    place: /toronto|montr[ée]al|ont/i, country: ["onc","quc"], years: [1960,2000],
  },
  {
    id: 'new-hogtown-press',
    search: ["New Hogtown Press"],
    match: /^[\s\["“”«»'(]*(new\s+hogtown\s+press)[\s\]"“”«»'),.;:!]*$/i,
    place: /toronto|ont/i, country: ["onc"], years: [1969,1995],
    allowNoPlace: true,
  },
  {
    id: 'fernwood-publishing',
    search: ["Fernwood Publishing","Fernwood"],
    match: /^[\s\["“”«»'(]*(fernwood(\s+publishing)?(\s+co(mpany|\.)?)?(,?\s+ltd\.?)?)[\s\]"“”«»'),.;:!]*$/i,
    place: /halifax|black\s+point|winnipeg|nova\s+scotia|n\.\s*s\./i, country: ["nsc","mbc"], years: [1991,2030],
  },
  {
    id: 'between-the-lines',
    search: ["Between the Lines"],
    match: /^[\s\["“”«»'(]*(between\s+the\s+lines)[\s\]"“”«»'),.;:!]*$/i,
    place: /toronto|ont/i, country: ["onc"], years: [1977,2030],
  },
  {
    id: 'en-lutte',
    search: ["En Lutte","In Struggle"],
    match: /^[\s\["“”«»'(]*((organisation\s+marxiste-l[ée]niniste\s+du\s+canada\s+)?en\s+lutte!?|in\s+struggle!?)[\s\]"“”«»'),.;:!]*$/i,
    place: /montr[ée]al|toronto|qu[ée]bec/i, country: ["quc","onc"], years: [1972,1982],
  },
  {
    id: 'socialist-party-of-canada',
    search: ["Socialist Party of Canada"],
    match: /^[\s\["“”«»'(]*(((dominion|manitoba\s+provincial)\s+executive\s+committee,?\s+)?socialist\s+party\s+of\s+canada)[\s\]"“”«»'),.;:!]*$/i,
    place: /vancouver|winnipeg|toronto|victoria/i, country: ["bcc","mbc","onc"], years: [1904,1995],
  },
  {
    id: 'editions-parti-pris',
    search: ["Éditions Parti pris"],
    match: /^[\s\["“”«»'(]*(([ée]ditions\s+)?parti\s+pris)[\s\]"“”«»'),.;:!]*$/i,
    place: /montr[ée]al/i, country: ["quc"], years: [1964,1984],
  },
  {
    id: 'partido-comunista-mexicano',
    search: ["Partido Comunista Mexicano"],
    match: /^[\s\["“”«»'(]*((ediciones\s+del\s+c\.?\s*c\.?\s+del\s+)?partido\s+comunista(\s+mexicano|\s+de\s+m[ée]xico)?)[\s\]"“”«»'),.;:!]*$/i,
    place: /m[ée]xico|m[ée]x\.|d\.\s*f\./i, country: ["mx"], years: [1919,1981],
  },
  {
    id: 'ediciones-frente-cultural',
    search: ["Ediciones Frente Cultural"],
    match: /^[\s\["“”«»'(]*(ediciones\s+(del\s+)?frente\s+cultural)[\s\]"“”«»'),.;:!]*$/i,
    place: /m[ée]xico|m[ée]x\.|d\.\s*f\./i, country: ["mx"], years: [1930,1950],
  },
  {
    id: 'universidad-obrera-de-mexico',
    search: ["Universidad Obrera de México"],
    match: /^[\s\["“”«»'(]*((ediciones\s+de\s+la\s+)?universidad\s+obrera\s+de\s+m[ée]xico)[\s\]"“”«»'),.;:!]*$/i,
    place: /m[ée]xico|m[ée]x\.|d\.\s*f\./i, country: ["mx"], years: [1936,2030],
  },
  {
    id: 'partido-popular-socialista',
    search: ["Partido Popular Socialista"],
    match: /^[\s\["“”«»'(]*((ediciones\s+del\s+)?partido\s+popular(\s+socialista)?)[\s\]"“”«»'),.;:!]*$/i,
    place: /m[ée]xico|m[ée]x\.|d\.\s*f\./i, country: ["mx"], years: [1948,1997],
  },
  {
    id: 'ediciones-era',
    search: ["Ediciones Era"],
    match: /^[\s\["“”«»'(]*((ediciones|editorial)\s+era(,?\s+s\.?\s*a\.?)?)[\s\]"“”«»'),.;:!]*$/i,
    place: /m[ée]xico|m[ée]x\.|d\.\s*f\./i, country: ["mx"], years: [1960,2030],
  },
  {
    id: 'editorial-nuestro-tiempo',
    search: ["Editorial Nuestro Tiempo"],
    match: /^[\s\["“”«»'(]*(editorial\s+nuestro\s+tiempo(,?\s+s\.?\s*a\.?)?)[\s\]"“”«»'),.;:!]*$/i,
    place: /m[ée]xico|m[ée]x\.|d\.\s*f\./i, country: ["mx"], years: [1965,2000],
  },
  {
    id: 'ediciones-quinto-sol',
    search: ["Ediciones Quinto Sol"],
    match: /^[\s\["“”«»'(]*(ediciones\s+quinto\s+sol)[\s\]"“”«»'),.;:!]*$/i,
    place: /m[ée]xico|m[ée]x\.|d\.\s*f\./i, country: ["mx"], years: [1978,2010],
  },

  // --- Eighteenth round: the Catalan communist presses (pinned on Catalonia)
  {
    id: 'psuc',
    search: ["Partit Socialista Unificat de Catalunya","Partit Socialista Unificat","Edicions Lluita"],
    match: /^[\s\["“”«»'(]*(((departament|secretariat|secretariado|dept\.?)\s+d['’]?\s*(agitaci[óo]n?|agit\.?)\s+(i|y)\s+propaganda\s+del\s+p\.?\s*s\.?\s*u\.?(\s+de\s+catalunya)?|partit\s+socialista\s+unificat(\s+de\s+catalunya)?(,?\s+comissi[óo]\s+central\s+agr[àa]ria)?|edicions\s+["“]?lluita["”]?|p\.\s*s\.\s*u\.\s*c\.?))[\s\]"“”«»'),.;:!]*$/i,
    place: /barcelona|tolosa|toulouse|limoges|par[ií]s|s\.\s*l\./i, country: ["sp","fr"], years: [1936,1997],
    allowNoPlace: true,
  },
  {
    id: 'editorial-marxista-poum',
    search: ["Editorial Marxista","Ediciones La Batalla","Partido Obrero de Unificación Marxista"],
    match: /^[\s\["“”«»'(]*(editorial\s+marxista|ediciones\s+["“]?la\s+batalla["”]?|["“]?la\s+batalla["”]?|partido\s+obrero\s+de\s+unificaci[óo]n\s+marxista(\.\s*comit[ée]\s+ejecutivo)?)[\s\]"“”«»'),.;:!]*$/i,
    place: /barcelona|par[ií]s/i, country: ["sp","fr"], years: [1935,1980],
  },
];
// Affirmed Marxist houses added in one batch, built from the table in lib/marxist-houses.mjs.
PUBLISHERS.push(...marxistRules());

/** Houses whose lists are only verified title-by-title, never bulk-imported. */
const VERIFY_ONLY = {
  // Club editions carry the Victor Gollancz imprint.
  'left-book-club': { match: /gollancz|left\s+book\s+club/i, place: /london/i, country: ['enk'], years: [1936, 1948] },
  // Early publishers of Marx, Engels and the Young Hegelians — verified title by title, since
  // most were general trade houses whose whole lists are outside the collection.
  'otto-wigand': { match: /wigand/i, place: /leipzig/i, country: ['gw'], years: [1833, 1870] },
  'otto-meissner': { match: /mei(ss|ß)ner/i, place: /hamburg/i, country: ['gw'], years: [1848, 1900] },
  'literarisches-comptoir': { match: /literarisch\w*\s+comptoir/i, place: /z[uü]rich|winterthur/i, country: ['sz'], years: [1841, 1845] },
  'workers-educational-association-london': { match: /bildungs[-\s]*gesellschaft|burghard/i, place: /london/i, country: ['enk', 'xxk'], years: [1848, 1848] },
  'franz-duncker': { match: /duncker/i, place: /berlin/i, country: ['gw'], years: [1850, 1878] },
  'genossenschaftsbuchdruckerei-leipzig': { match: /genossenschafts[-\s]*buchdruckerei/i, place: /leipzig/i, country: ['gw'], years: [1872, 1881] },
  'literarische-anstalt': { match: /literarische\s+anstalt|r[uü]tten/i, place: /frankfurt/i, country: ['gw'], years: [1844, 1859] },
  'deutsch-franzosische-jahrbucher': { match: /bureau\s+der\s+jahrb|deutsch[-\s]*franz/i, place: /paris/i, country: ['fr'], years: [1844, 1844] },
  'die-revolution-new-york': { match: /revolution|weydemeyer/i, place: /new\s*york/i, country: ['nyu'], years: [1852, 1852] },
  'marx-engels-verlag': { match: /marx[-\s]*engels[-\s]*(verlag|archiv)|verlagsgenossenschaft\s+ausl/i, place: /berlin|frankfurt|moskau|moscow/i, country: ['gw', 'ur'], years: [1927, 1935] },
};

const LANGUAGES = {
  eng: 'English', fre: 'French', ger: 'German', spa: 'Spanish', rus: 'Russian', chi: 'Chinese',
  ita: 'Italian', por: 'Portuguese', ara: 'Arabic', hin: 'Hindi', vie: 'Vietnamese', kor: 'Korean',
  jpn: 'Japanese', pol: 'Polish', cze: 'Czech', hun: 'Hungarian', per: 'Persian', urd: 'Urdu',
  ben: 'Bengali', tam: 'Tamil', tel: 'Telugu', mal: 'Malayalam', mar: 'Marathi', swa: 'Swahili',
  ind: 'Indonesian', may: 'Malay', tur: 'Turkish', gre: 'Greek', dut: 'Dutch', swe: 'Swedish',
  nor: 'Norwegian', dan: 'Danish', fin: 'Finnish', rum: 'Romanian', bul: 'Bulgarian', srp: 'Serbian',
  hrv: 'Croatian', scc: 'Serbian', scr: 'Croatian', alb: 'Albanian', heb: 'Hebrew', yid: 'Yiddish',
  esp: 'Esperanto', lat: 'Latin', mon: 'Mongolian', bur: 'Burmese', tha: 'Thai', lao: 'Lao',
  khm: 'Khmer', nep: 'Nepali', sin: 'Sinhala', amh: 'Amharic', hau: 'Hausa', pan: 'Punjabi',
  guj: 'Gujarati', kan: 'Kannada', ori: 'Oriya', ukr: 'Ukrainian', bel: 'Belarusian', geo: 'Georgian',
  arm: 'Armenian', aze: 'Azerbaijani', uzb: 'Uzbek', kaz: 'Kazakh', lit: 'Lithuanian', lav: 'Latvian',
  est: 'Estonian', slo: 'Slovak', slv: 'Slovenian', mac: 'Macedonian', ice: 'Icelandic', wel: 'Welsh',
  gle: 'Irish', tgl: 'Tagalog', som: 'Somali', mul: 'Multiple languages',
  cmn: 'Chinese', glg: 'Galician', gag: 'Galician', baq: 'Basque', cat: 'Catalan', lad: 'Ladino',
  bre: 'Breton', ber: 'Berber', kab: 'Kabyle', epo: 'Esperanto', afr: 'Afrikaans', ven: 'Venda',
  tgk: 'Tajik', taj: 'Tajik', nah: 'Nahuatl', san: 'Sanskrit', grc: 'Ancient Greek', shn: 'Shan',
  tai: 'Tai', vai: 'Vai', cai: 'Central American Indian', sla: 'Slavic', cau: 'Caucasian', roa: 'Romance',
  kir: 'Kyrgyz', tuk: 'Turkmen', tut: 'Turkic', rom: 'Romani', tib: 'Tibetan', uig: 'Uyghur', tat: 'Tatar',
  che: 'Chechen', chv: 'Chuvash', mis: 'Other', fiu: 'Finno-Ugric', ava: 'Avar', tir: 'Tigrinya', sit: 'Sino-Tibetan',
  oss: 'Ossetian', nic: 'Niger-Congo', kur: 'Kurdish', kaa: 'Karakalpak', chu: 'Church Slavonic', bak: 'Bashkir',
  ang: 'Old English', syr: 'Syriac', srr: 'Serer', peo: 'Old Persian', myn: 'Mayan', mno: 'Manobo', mnc: 'Manchu',
  mlg: 'Malagasy', gla: 'Scottish Gaelic', gem: 'Germanic', crp: 'Creole', cpf: 'French Creole', bug: 'Buginese', afa: 'Afroasiatic',
  sel: 'Selkup', pro: 'Old Provençal', que: 'Quechua', mao: 'Maori', tet: 'Tetum',
};

/**
 * Language corrections for single editions, checked against the fields 008 and 041 of the library
 * MARC records Open Library imported (LoC, Columbia, Toronto, Harvard). Most are translations whose
 * source language was catalogued as a language of the text.
 */
const LANGUAGE_FIXES = {
  '/books/OL24213148M': { language: 'English', note: 'Translated from Venda.' }, // Mafangambiti
  '/books/OL2332237M': { language: 'English', note: 'Translated from Venda.' }, // Mafangambiti
  '/books/OL2565769M': { language: 'English', note: 'Translated from Tajik.' }, // At the Foot of Blue Mountains
  '/books/OL2774150M': { language: 'English', note: 'Translated from Abkhaz, via Russian.' }, // The Last of the Departed
  '/books/OL16378979M': { language: 'English' }, // Ashma
  '/books/OL52695565M': { language: 'Spanish' }, // Interpretación teórica de la ciencia: miscoded Esperanto
  '/books/OL23836110M': { language: 'Vietnamese' }, // Khoa học phát triển: LoC 008 vie, "vai" is a typo
  '/books/OL3269632M': { language: 'Russian, English, Old Russian' }, // Slovo o polku Igoreve
  '/books/OL1590681M': { language: 'Miskito, Spanish' }, // Wangki bilara tuktan wal impakanka
  '/books/OL58241619M': { language: 'Spanish, Cahita' }, // Arte de la lengua cahita
  '/books/OL60289262M': { language: 'Vietnamese, English, French, Tai Dam' }, // Lò Cầm genealogy
  '/books/OL20125036M': { language: 'Kabyle, French' }, // Mon nom est combat
  '/books/OL22491790M': { language: 'French, Kabyle' }, // Poèmes kabyles anciens
  // Galician books catalogued only as "Romance (Other)", or with Galician read as Portuguese.
  '/books/OL18548886M': { language: 'Galician, Spanish' }, // Os novísimos da poesía galega
  '/books/OL57267603M': { language: 'Galician' }, // As cruces de pedra na Galiza
  '/books/OL4298889M': { language: 'Galician, Spanish' }, // Da terra asoballada
  '/books/OL50348717M': { language: 'Galician, Spanish' }, // Cancionero popular gallego
  '/books/OL22404321M': { language: 'Galician' }, // Historia de Galiza (LoC 008 glg)
  '/books/OL21478322M': { language: 'Galician' }, // O ciclo do neno (LoC 008 glg)
  '/books/OL4451241M': { language: 'Galician, Basque, Catalan, Spanish' }, // Seis poemas galegos (LoC 041)
};

const unknownLanguages = new Set();
function unknownLanguage(code) {
  if (!unknownLanguages.has(code)) { unknownLanguages.add(code); console.warn(`  unknown language code: ${code}`); }
  return 'Other';
}

/** Language names of an edition, less the languages it was translated from. */
function languagesOfEdition(ed) {
  const code = (l) => l.key.split('/').pop();
  const from = new Set((ed.translated_from ?? []).map(code));
  let langs = (ed.languages ?? []).map(code).filter((c) => c !== 'und' && !from.has(c));
  // Galician was catalogued as "Romance (Other)" before it had a code of its own.
  if (langs.includes('glg') || langs.includes('gag')) langs = langs.filter((c) => c !== 'roa');
  // A code missing from LANGUAGES is reported once rather than shown raw.
  return [...new Set(langs.map((c) => LANGUAGES[c] ?? unknownLanguage(c)))];
}


/**
 * Returns the rule's verdict for an edition: 'match', 'match-no-place' (accepted, but cannot be
 * verified), a rejection reason, or null (not this publisher).
 */
// Russian in Cyrillic, written as the Library of Congress romanises it (without its diacritics).
const CYRILLIC = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
  п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: "'", э: 'e',
  ю: 'iu', я: 'ia', і: 'i', ї: 'i', є: 'ie', ґ: 'g', ў: 'u',
};
const romanise = (s) => s.replace(/[Ѐ-ӿ]/g, (c) => {
  const r = CYRILLIC[c.toLowerCase()] ?? c;
  return c === c.toLowerCase() ? r : r.charAt(0).toUpperCase() + r.slice(1);
});
// A DIN 1460 romanisation (the German catalogues': "Chudožestvennaja literatura") in the Library of
// Congress's form ("Khudozhestvennaia literatura"), when the imprint reads as one.
const DIN_LIKE = /[čžšČŽŠ]|ja\b|ij\b|\bja/;
const dinToLoc = (s) => s.replace(/ch/g, 'kh').replace(/Ch/g, 'Kh').replace(/c/g, 'ts').replace(/C/g, 'Ts').replace(/šč/g, 'shch').replace(/č/g, 'ch').replace(/Č/g, 'Ch')
  .replace(/ž/g, 'zh').replace(/Ž/g, 'Zh').replace(/š/g, 'sh').replace(/Š/g, 'Sh')
  .replace(/j([aeu])/g, 'i$1').replace(/J([aeu])/g, 'I$1').replace(/j\b/g, 'i');
// "Izdat. «Nauka»", "Izd. Mysl'", "'Molodaja Gvardija'", "Nauka, Leningradskoe otdelenie": the house's name
// alone, without the word for publishing house, quotation marks, or a branch or section.
const stripImprint = (s) => s.replace(/^[\s«"„“'ʺ[]*((izdat(\.|el['ʹ]?stvo|\b)|izd(\.|-vo)|farlag|(vyd\.?\s+)?nakl(\.|ad\.|adatelstv[ií]))\s*[«"„“'ʺ]*)?/i, '')
  // The Komsomol's house by its full name, "Izd-vo TsK VLKSM «Molodaia gvardiia»".
  .replace(/^(ts?k|ц\.?\s?к\.?)\s+(vlksm|влксм)\s*[«"„“'ʺ]*/i, '')
  .replace(/,?\s+(leningradsk\S*|sibirsk\S*|leningrad\.?)\s+otd\S*.*$|,\s*(glav(\.|naja|naia|naâ)|otd(\.|elenie)).*$/i, '')
  .replace(/[»"“”'ʺ\]]+$/, '').trim();
// The forms are kept only for the records being matched now (each is judged against every rule in
// turn); holding them for every edition of the import exhausts its memory.
const imprintForms = new Map();
/** The forms an edition's publishers and places are matched in: as recorded, and normalised. */
function formsOf(ed) {
  let forms = imprintForms.get(ed);
  if (forms) return forms;
  if (imprintForms.size >= 5000) imprintForms.clear();
  // Catalogue records often store accents decomposed ("e" + combining acute); rules are written composed.
  const pubs = new Set((ed.publishers ?? []).map((p) => p.trim().normalize('NFC')));
  for (const p of [...pubs]) if (/[Ѐ-ӿ]/.test(p)) pubs.add(romanise(p));
  for (const p of [...pubs]) if (DIN_LIKE.test(p)) pubs.add(dinToLoc(p));
  for (const p of [...pubs]) { const s = stripImprint(p); if (s && s !== p) pubs.add(s); }
  // Pinyin written syllable by syllable, the place's too ("Shang hai ren min chu ban she"), which
  // the rules, written with a place's syllables joined, read without its spaces.
  for (const p of [...pubs]) if (/chu\s+ban\s+she/i.test(p)) pubs.add(p.replace(/\s+/g, ''));
  let places = (ed.publish_places ?? []).join(' ; ');
  // The German names of East European capitals, as the German catalogues may give them.
  if (/warschau|\bprag\b|bukarest|belgrad\b|krakau|pressburg/i.test(places)) places += ' ; ' + places.replace(/warschau/gi, 'Warszawa')
    .replace(/\bprag\b/gi, 'Praha').replace(/bukarest/gi, 'Bucureşti').replace(/belgrad\b/gi, 'Beograd').replace(/krakau/gi, 'Kraków').replace(/pressburg/gi, 'Bratislava');
  // Pinyin places are often written syllable by syllable ("Bei jing", "Shang hai").
  const all = /[Ѐ-ӿ]/.test(places) ? `${places} ; ${romanise(places)}` : places;
  forms = { pubs: [...pubs], places: / [a-z]/.test(all) ? `${all} ; ${all.replace(/ (?=[a-z])/g, '')}` : all };
  imprintForms.set(ed, forms);
  return forms;
}

function judge(ed, rule) {
  const { pubs, places } = formsOf(ed);
  if (!pubs.some((p) => rule.match.test(p))) return null;
  const year = yearOf(ed.publish_date);
  if (year && (year < rule.years[0] || year > rule.years[1])) return 'out-of-range';
  const country = (ed.publish_country ?? '').trim();
  const known = places || (country && !/^xx\s*$/.test(country));
  if (!known) return rule.allowNoPlace && year ? 'match-no-place' : 'no-place';
  const placeOk = places ? rule.place.test(places) : rule.country.includes(country);
  return placeOk ? 'match' : 'other-place';
}

/**
 * The first filter on the Hathifiles' imprints: the most distinctive word of each of the houses'
 * names ("britain" of "Communist Party of Great Britain"), or a name's longest word when every word
 * is common ("Workers Library Publishers").
 */
function hathiFilter() {
  const GENERIC = new Set(['press', 'publishers', 'publisher', 'publishing', 'publications', 'books', 'book', 'house', 'company', 'verlag',
    'editions', 'edition', 'editorial', 'ediciones', 'edizioni', 'library', 'the', 'and', 'for', 'des', 'der', 'del', 'of',
    'party', 'communist', 'socialist', 'workers', 'national', 'state', 'people', 'peoples', 'international', 'new', 'red']);
  const words = (s) => String(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const longest = (list) => [...list].sort((a, b) => b.length - a.length)[0];
  const distinctive = new Set();
  for (const p of PUBLISHERS) for (const t of p.search) {
    const all = words(t).filter((w) => w.length >= 3);
    const best = longest(all.filter((w) => !GENERIC.has(w))) ?? longest(all);
    if (best) distinctive.add(best);
  }
  return (imprint) => words(imprint).some((w) => distinctive.has(w));
}

// What the Hathifiles would give each house, without an import: `node scripts/import-openlibrary.mjs --test-hathi`.
if (process.argv.includes('--test-hathi')) {
  const started = Date.now();
  const byHouse = new Map();
  // The titles each house has on file (title and year), to count what would be new.
  const onFile = new Map();
  const haveKeys = (id) => {
    if (!onFile.has(id)) {
      const file = join(CATALOGUES, id, 'openlibrary.yaml');
      let titles = [];
      try { titles = yaml.load(readFileSync(file, 'utf8'))?.titles ?? []; } catch { /* a house with no titles yet */ }
      onFile.set(id, new Set(titles.map((t) => `${titleKey(t.title)}|${t.year ?? ''}`)));
    }
    return onFile.get(id);
  };
  let candidates = 0;
  for await (const batch of hathiRecords(hathiFilter())) {
    candidates += batch.length;
    for (const rec of batch) {
      const rule = PUBLISHERS.find((r) => ['match', 'match-no-place'].includes(judge(rec, r)));
      if (!rule) continue;
      const e = byHouse.get(rule.id) ?? { n: 0, fresh: 0, freshEnglish: 0, freshOpen: 0 };
      e.n++;
      if (!haveKeys(rule.id).has(`${titleKey(rec.title ?? '')}|${yearOf(rec.publish_date) ?? ''}`)) {
        e.fresh++; if (rec.languageNames[0] === 'eng') e.freshEnglish++; if (rec.digital) e.freshOpen++;
      }
      byHouse.set(rule.id, e);
    }
  }
  const sum = (k) => [...byHouse.values()].reduce((s, e) => s + e[k], 0);
  console.log(`${candidates} candidate records; ${sum('n')} matched; new to their house: ${sum('fresh')} (${sum('freshEnglish')} English, ${sum('freshOpen')} open) in ${Math.round((Date.now() - started) / 1000)} s`);
  const line = ([id, e]) => `  ${id}: ${e.fresh} new of ${e.n} (${e.freshEnglish} English, ${e.freshOpen} open)`;
  console.log('Most new titles:');
  for (const entry of [...byHouse].sort((a, b) => b[1].fresh - a[1].fresh).slice(0, 30)) console.log(line(entry));
  console.log('Most new English titles:');
  for (const entry of [...byHouse].sort((a, b) => b[1].freshEnglish - a[1].freshEnglish).slice(0, 30)) console.log(line(entry));
  console.log('Pamphlet houses:');
  for (const id of ['communist-party-of-great-britain', 'workers-library-publishers', 'new-century-publishers', 'communist-party-usa', 'daily-worker-publishing-company',
    'international-publishers', 'charles-h-kerr', 'new-york-labor-news-company', 'pioneer-publishers', 'socialist-party-of-america', 'independent-labour-party'])
    console.log(byHouse.has(id) ? line([id, byHouse.get(id)]) : `  ${id}: none`);
  process.exit(0);
}

// A check of the rules alone: `node scripts/import-openlibrary.mjs --test-match "Molodaja gvardija|Moskva|1975" …`
// prints the house each imprint (publisher|place|year) would be given to, and exits.
if (process.argv.includes('--test-match')) {
  for (const arg of process.argv.slice(process.argv.indexOf('--test-match') + 1)) {
    const [publisher, place = '', year = ''] = arg.split('|');
    const ed = { publishers: [publisher], publish_places: place ? [place] : [], publish_date: year };
    const rule = PUBLISHERS.find((r) => ['match', 'match-no-place'].includes(judge(ed, r)));
    console.log(`${arg} => ${rule?.id ?? '(none)'}`);
  }
  process.exit(0);
}

const SOVIET_CODES = ['ru', 'ur', 'un', 'bw', 'er', 'lv', 'li', 'gs', 'ai', 'aj', 'kz', 'kg', 'tg', 'tk', 'uz', 'mv'];
// The DIN forms of a Library of Congress romanisation. A plain final "ii" may be ий or ии
// ("Sovetskii", "Akademii"), so both forms are given; only "t͡s", with its tie, is ц.
const dinOne = (t) => t.replace(/shch/gi, 'šč').replace(/t[︠͡]s︡?/g, 'c').replace(/T[︠͡]s︡?/g, 'C')
  .replace(/kh/g, '\u0001').replace(/Kh/g, '\u0002').replace(/zh/g, 'ž').replace(/Zh/g, 'Ž')
  .replace(/ch/g, 'č').replace(/Ch/g, 'Č').replace(/sh/g, 'š').replace(/Sh/g, 'Š')
  .replace(/ia/g, 'ja').replace(/iu/g, 'ju').replace(/ĭ/g, 'j').replace(/[ʹ’]/g, "'").replace(/[︠︡͡]/g, '')
  .replace(/\u0001/g, 'ch').replace(/\u0002/g, 'Ch');
const din = (t) => [...new Set([dinOne(t), dinOne(t).replace(/ii\b/g, 'ij').replace(/yi\b/g, 'yj')])].filter((v) => v !== t);
const unionYears = new Map();
for (const p of PUBLISHERS) {
  const soviet = p.country?.some((c) => SOVIET_CODES.includes(c));
  for (const t of p.search.flatMap((t) => (soviet ? [t, ...din(t)] : [t]))) {
    const [from, until] = unionYears.get(t) ?? [Infinity, -Infinity];
    unionYears.set(t, [Math.min(from, p.years[0]), Math.max(until, p.years[1])]);
  }
}
/** Each name, or each name and year when the catalogue holds more of its records than one search returns. */
async function slicedTerms(count, cap) {
  const terms = [];
  for (const [t, [from, until]] of unionYears) {
    const n = await count(t);
    if (n === 0) continue;
    if (n < cap) { terms.push(t); continue; }
    for (let y = Math.max(from, 1900); y <= Math.min(until, new Date().getFullYear()); y++) terms.push([t, y]);
  }
  return terms;
}

// The union catalogues' searches, fetched into the cache and not matched, so that they can be
// downloaded while another import runs: `node scripts/import-openlibrary.mjs --prefetch-union=k10plus`.
const UNION = {
  k10plus: [k10plusRecords, k10plusCount, 10000], b3kat: [b3katRecords, b3katCount, 5000], bne: [bneRecords, bneCount, 2000],
};
const prefetchArg = process.argv.find((a) => a.startsWith('--prefetch-union='));
if (prefetchArg) {
  const [fetchRecords, count, cap] = UNION[prefetchArg.split('=')[1]];
  const terms = await slicedTerms(count, cap);
  console.log(`${terms.length} searches`);
  let done = 0, records = 0;
  for (const term of terms) {
    records += (await fetchRecords(...[].concat(term))).length;
    if (++done % 100 === 0) console.log(`  ${done}/${terms.length} searches, ${records} records (${sourceRequests} requests)`);
  }
  console.log(`Done: ${terms.length} searches, ${records} records.`);
  process.exit(0);
}

/** Houses whose records use East Asian name order (family name first). */
const EAST_ASIAN_HOUSES = new Set([
  'foreign-languages-press-beijing', 'new-world-press-beijing', 'peoples-publishing-house-beijing',
  'shanghai-peoples-publishing-house', 'tianjin-peoples-publishing-house', 'study-press',
  'party-building-books-publishing-house', 'foreign-languages-publishing-house-pyongyang',
  'workers-party-of-korea-publishing-house', 'foreign-languages-publishing-house-hanoi',
  'central-party-literature-press', 'literature-and-art-publishing-house-pyongyang', 'shin-nihon-shuppansha', 'otsuki-shoten', 'aoki-shoten', 'su-that', 'jiefang-she', 'xin-qing-nian-she',
  'korean-writers-union-publishing-house', 'kumsong-youth-publishing-house',
]);

/**
 * The edition's authors; when the edition names none, the authors recorded on its work (less
 * anyone the title page credits as translator or editor), then a personal name read from the
 * title page's statement of responsibility.
 */
function authorsOf(ed) {
  const own = (ed.authors ?? [])
    .map((a) => ({ name: authorNames.get(a.key), alternates: authorAlternates.get(a.key) ?? [] }))
    .filter((a) => a.name);
  if (own.length) return own;
  const secondary = secondaryNames(ed.by_statement);
  const fromWork = (workAuthors.get(ed.works?.[0]?.key) ?? []).filter((n) => !secondary.includes(surname(n)));
  if (fromWork.length) return fromWork.map((name) => ({ name, alternates: [] }));
  return authorsFromStatement(ed.by_statement).map((name) => ({ name, alternates: [] }));
}

/** Regional-language houses, whose authors are shown with their native-script names as well. */
const REGIONAL_LANGUAGE_HOUSES = new Set([
  'national-book-agency', 'manisha-granthalaya', 'chintha-publishers', 'prabhath-book-house',
  'new-century-book-house', 'visalaandhra-publishing-house', 'prajasakti-book-house', 'lok-vangmay-griha',
  'navakarnataka-publications',
]);

function toTitle(ed, rule) {
  const options = { eastAsian: EAST_ASIAN_HOUSES.has(rule.id), showNative: REGIONAL_LANGUAGE_HOUSES.has(rule.id) };
  const authors = [
    ...new Set(
      authorsOf(ed)
        .filter((a) => !rule.match.test(a.name) && !/publishing house|foreign languages/i.test(a.name))
        .map((a) => displayAuthor(a.name, a.alternates, options))
        .filter(Boolean),
    ),
  ];
  const year = yearOf(ed.publish_date);
  const rawDate = String(ed.publish_date ?? '').trim();
  const langs = languagesOfEdition(ed);
  const catalogued = isCatalogued(ed);
  const fix = LANGUAGE_FIXES[ed.key];
  const title = clean(ed.title) ?? '[Untitled]';
  // A title catalogued as English but written in another language takes that language.
  const recorded = fix?.language ?? (langs.length ? langs.join(', ') : 'Not recorded');
  // The subtitle counts too: "Les Huks: Dans la forêt des Philippines".
  const language = recorded === 'English' ? foreignTitleLanguage(`${title} ${clean(ed.subtitle) ?? ''}`) ?? recorded : recorded;
  let subtitle = clean(ed.subtitle);
  if (subtitle && titleKey(title).endsWith(titleKey(subtitle))) subtitle = undefined; // already in the title
  const english = isEnglishTitle(title, language === 'Not recorded' ? undefined : language);

  const t = {
    title: formatTitle(title, english, language),
    subtitle: formatTitle(subtitle, english, language),
    authors,
    year,
    date_note: year && rawDate && rawDate !== String(year) && /[?\[\]c]|\d{4}\s*-/.test(rawDate) ? rawDate : undefined,
    edition: clean(ed.edition_name),
    series: formatTitle(clean(ed.series?.[0]), english, language),
    language,
    notes: fix?.note,
    pages: Number.isInteger(ed.number_of_pages) && ed.number_of_pages > 0 ? ed.number_of_pages : undefined,
    isbn: ed.isbn_13?.[0] ?? ed.isbn_10?.[0],
    links: ed.ocaid ? [{ label: 'Scan (Internet Archive)', url: `https://archive.org/details/${ed.ocaid}` }] : [],
    sources: catalogueSources(ed),
    verified: catalogued && Boolean(year),
  };
  for (const k of Object.keys(t)) if (t[k] === undefined || (Array.isArray(t[k]) && !t[k].length && k !== 'authors')) delete t[k];
  return t;
}

function mergeInto(target, t) {
  const urls = new Set(target.sources.map((s) => s.url));
  for (const s of t.sources) if (!urls.has(s.url)) target.sources.push(s);
  for (const l of t.links ?? []) if (!(target.links ?? []).some((x) => x.url === l.url)) (target.links ??= []).push(l);
  target.verified ||= t.verified;
  for (const k of ['subtitle', 'pages', 'isbn', 'series', 'edition', 'date_note']) target[k] ??= t[k];
  if (!target.authors.length) target.authors = t.authors;
  if (target.language === 'Not recorded') target.language = t.language;
}

/** Ranks records of one edition to choose which to keep as the displayed record. */
const recordQuality = (t) =>
  (t.verified ? 8 : 0) +
  (t.authors.length ? 4 : 0) +
  (t.language !== 'Not recorded' && !t.language.includes(', ') ? 2 : 0) + // "English" over "English, Chinese"
  (/^(the|a|an) /i.test(t.title) ? 1 : 0); // keeps a leading article some records drop

/** Merges duplicate records of the same edition into one, keeping every catalogue source. */
function dedupe(titles) {
  return groupDuplicates(titles).map((group) => {
    const [best, ...rest] = group.sort((a, b) => recordQuality(b) - recordQuality(a));
    for (const t of rest) mergeInto(best, t);
    // A subtitle merged in from another record may repeat the end of this record's title.
    if (best.subtitle && titleKey(best.title).endsWith(titleKey(best.subtitle))) delete best.subtitle;
    return best;
  });
}

const sameBook = (a, b) =>
  titleKey(a.title) === titleKey(b.title) &&
  authorsOverlap(a.authors, b.authors) &&
  (a.language === b.language || a.language === 'Not recorded' || b.language === 'Not recorded');

/**
 * An undated record of a book that also has a dated record at the same house is not a
 * separate edition. With exactly one dated match its sources are merged in; with several,
 * the record cannot be placed and is dropped.
 */
function absorbUndated(titles) {
  const dated = titles.filter((t) => t.year);
  return titles.filter((t) => {
    if (t.year) return true;
    const matches = dated.filter((d) => sameBook(t, d));
    if (matches.length === 1) mergeInto(matches[0], { ...t, subtitle: undefined });
    return matches.length === 0;
  });
}

// ---------------------------------------------------------------------------
// Hand-entered catalogue files
// ---------------------------------------------------------------------------

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.ya?ml$/.test(f) ? [p] : [];
  });
}

function loadHandFiles() {
  return walk(CATALOGUES)
    .filter((f) => !f.endsWith(GENERATED))
    .map((file) => ({ file, doc: yaml.load(readFileSync(file, 'utf8')) }));
}

async function verifyHandTitle(hand, rule) {
  const author = hand.authors?.[0];
  const pseudonymous = !author || /^the |vigilantes|pied piper/i.test(author);
  const candidates = (await editionsForTitle(hand.title, pseudonymous ? undefined : author)).filter(
    (ed) => judge(ed, rule) === 'match' && titlesMatch(hand, { title: clean(ed.title) ?? '', subtitle: clean(ed.subtitle) }),
  );
  const exact = candidates.filter((ed) => yearOf(ed.publish_date) === hand.year && isCatalogued(ed));
  return { exact, near: candidates.filter((ed) => !exact.includes(ed)) };
}


// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const review = { 'no-place': [], 'other-place': [], 'out-of-range': [] };
const byPublisher = new Map(PUBLISHERS.map((p) => [p.id, []]));

console.log('Discovering imprint spellings…');
const imprints = new Set();
const anyRule = new RegExp(PUBLISHERS.map((p) => p.match.source).join('|'), 'i');
for (const p of PUBLISHERS) {
  for (const term of p.search) for (const s of await discoverImprints(term, anyRule)) imprints.add(s);
  checkBudget();
}
console.log(`  ${imprints.size} spellings`);
if (process.argv.includes('--list')) {
  console.log([...imprints].map((s) => `  ${JSON.stringify(s)}`).join('\n'));
  process.exit(0);
}

console.log('Fetching editions…');
const editions = new Map();
for (const imprint of imprints) {
  for (const ed of await editionsByPublisher(imprint)) editions.set(ed.key, ed);
  checkBudget();
}
console.log(`  ${editions.size} editions (${requestCount()} requests so far)`);

checkBudget();
await resolveAuthors([...editions.values()].flatMap((ed) => (ed.authors ?? []).map((a) => a.key)));

// Editions in the collection that name no author: look up the authors recorded on their works.
const authorless = [...editions.values()].filter(
  (ed) => !ed.authors?.length && ed.works?.[0]?.key && PUBLISHERS.some((rule) => judge(ed, rule)?.startsWith('match')),
);
console.log(`Looking up work authors for ${authorless.length} editions without an author…`);
checkBudget();
await resolveWorkAuthors(authorless.map((ed) => ed.works[0].key));

for (const ed of editions.values()) {
  let claimed = false;
  const reasons = [];
  for (const rule of PUBLISHERS) {
    const verdict = judge(ed, rule);
    if (verdict === 'match' || verdict === 'match-no-place') {
      const t = toTitle(ed, rule);
      if (verdict === 'match-no-place') t.verified = false;
      if (!rule.exclude?.(t)) byPublisher.get(rule.id).push(t);
      claimed = true;
      break;
    }
    if (verdict) reasons.push(verdict);
  }
  if (!claimed && reasons.length) {
    const reason = reasons.includes('out-of-range') ? 'out-of-range' : reasons.includes('no-place') ? 'no-place' : 'other-place';
    review[reason].push(ed);
  }
}

// ---------------------------------------------------------------------------
// Cross-referencing: the Internet Archive and BannedThought.net
// ---------------------------------------------------------------------------
// Their records are judged by the same publisher rules. A scan or PDF of an edition already in the
// catalogue merges into it during duplicate grouping below (adding a "read" link and a source); an
// edition the catalogue lacks is added as a new, unverified title.

/**
 * Numbers of International Publishers' paperback series from its own catalogues and checklists:
 * [number, author's surname, title's beginning]. A record that names the series without its number
 * takes the number of the matching entry. The numbering is not continuous, and some works were
 * reissued under a second number (The German Ideology is NW-6 and NW-143), so a record without the
 * series is never given one.
 */
export const SERIES_CHECKLIST = [
  ['NW-1', 'Selsam', 'What Is Philosophy'], ['NW-2', 'Aptheker', 'The American Revolution'], ['NW-3', 'Reed', 'The Education of John Reed'],
  ['NW-4', 'Marx', 'Letters to Americans'], ['NW-5', 'Engels', 'Dialectics of Nature'], ['NW-6', 'Marx', 'The German Ideology'],
  ['NW-7', 'Hunton', 'Decision in Africa'], ['NW-8', 'Perlo', 'USA and USSR'], ['NW-9', 'Foner', 'Mark Twain'],
  ['NW-10', 'Finkelstein', 'Composer and Nation'], ['NW-11', 'North', 'No Men Are Strangers'], ['NW-12', 'Wells', 'Ivan P. Pavlov'],
  ['NW-13', 'Wells', 'Sigmund Freud'], ['NW-14', 'Lewis', 'Socialism and the Individual'], ['NW-15', 'Robertson', 'The Origins of Christianity'],
  ['NW-16', 'Du Bois', 'John Brown'], ['NW-18', 'Selsam', 'Reader in Marxist Philosophy'], ['NW-19', 'Perlo', 'Militarism and Industry'],
  ['NW-22', 'Flynn', 'The Alderson Story'], ['NW-23', 'Allen', 'Reconstruction'], ['NW-24', 'Aptheker', 'American Negro Slave Revolts'],
  ['NW-25', 'Mulzac', 'A Star to Steer By'], ['NW-29', 'Dutt', 'Problems of Contemporary History'], ['NW-30', 'Meek', 'Marx and Engels on Malthus'],
  ['NW-31', 'Pavlov', 'Lectures on Conditioned Reflexes'], ['NW-32', 'Pavlov', 'Conditioned Reflexes and Psychiatry'], ['NW-33', 'Labor Research', 'Labor Fact Book'],
  ['NW-34', 'Burchett', 'The Furtive War'], ['NW-36', 'Engels', 'The Origin of the Family'], ['NW-37', 'Kemp', 'Diderot'],
  ['NW-38', 'Caudwell', 'Illusion and Reality'], ['NW-39', 'Bruno', 'Cause, Principle and Unity'], ['NW-40', 'Dobb', 'Studies in the Development of Capitalism'],
  ['NW-41', 'Dobb', 'Economic Growth and Underdeveloped Countries'], ['NW-92', 'Lightfoot', 'Ghetto Rebellion to Black Liberation'], ['NW-102', 'Major', 'The New Black Poetry'],
  ['NW-107', 'Lenin', 'What Is to Be Done'], ['NW-109', 'Nkrumah', 'Neo-Colonialism'], ['NW-133', 'Gramsci', 'The Modern Prince'],
  ['NW-140', 'Struik', 'Birth of the Communist Manifesto'], ['NW-142', 'Civil Rights Congress', 'We Charge Genocide'], ['NW-143', 'Marx', 'The German Ideology'],
  ['NW-144', 'Hall', 'Imperialism Today'], ['NW-146', 'Green', 'The New Radicalism'], ['NW-153', 'Marx', 'Anarchism and Anarcho-Syndicalism'],
  ['NW-160', 'Plekhanov', 'The Development of the Monist View of History'], ['NW-166', 'Lumer', 'Zionism'], ['NW-175', 'Pomeroy', 'An American Made Tragedy'],
  ['NW-190', 'Kim', 'For the Independent, Peaceful Reunification of Korea'], ['NW-419', 'Perlo', 'Economics of Racism'], ['NW-430', 'Togliatti', 'Lectures on Fascism'],
  ['NW-472', 'Hoffman', 'Marxism and the Theory of Praxis'], ['NW-477', 'Lightfoot', 'Human Rights U.S. Style'], ['NW-501', 'Aptheker', 'The Unfolding Drama'],
  ['NW-503', 'Anikin', 'A Science in Its Youth'], ['NW-554', 'Lawler', 'IQ, Heritability, and Racism'], ['NW-577', 'Perlo', 'Dynamic Stability'],
  ['NW-582', 'Zipser', 'Workingclass Giant'], ['NW-589-1', 'Colón', 'A Puerto Rican in New York'], ['NW-596', 'Foner', 'On the Eve of America'],
  ['NW-605-5', 'Morray', 'Project Kuzbas'], ['NW-614-6', 'Boorstein', "What's Ahead"],
  ['NW-S-4', 'Montagu', 'With Eisenstein in Hollywood'], ['NW-S-7', 'Du Bois', 'An ABC of Color'], ['NW-S-19', 'Foner', 'Mark Twain'], ['NW-S-25', 'Du Bois', 'John Brown'],
  ['LNW-1', 'Pomeroy', 'Guerrilla and Counter-Guerrilla Warfare'], ['LNW-2', 'Lumer', 'Poverty'], ['LNW-3', 'Budish', 'Is Communism the Next Stage'],
  ['LNW-4', 'Pittman', 'Peaceful Coexistence'], ['LNW-5', 'Selsam', 'Ethics and Progress'], ['LNW-6', 'Ryerson', 'The Open Society'],
  ['LNW-7', 'Dunson', 'Freedom in the Air'], ['LNW-8', 'Spark', 'Some Essential Features of Nkrumaism'], ['LNW-9', 'Burns', 'An Introduction to Marxism'],
  ['LNW-10', 'Hernandez', 'Rice Grains'], ['LNW-11', 'Bryant', 'William Cullen Bryant'], ['LNW-12', 'Morris', 'CIA and American Labor'],
  ['LNW-13', 'Pomeroy', 'Half a Century of Socialism'], ['LNW-14', 'Aptheker', 'The Nature of Democracy'], ['LNW-15', 'Woddis', 'Introduction to Neo-Colonialism'],
  ['LNW-16', 'Nkrumah', 'Dark Days in Ghana'], ['LNW-17', 'Nkrumah', 'Handbook of Revolutionary Warfare'], ['LNW-18', 'Nkrumah', 'Axioms'],
  ['LNW-19', 'Marx', 'The Woman Question'], ['LNW-21', 'Green', 'Revolution Cuban Style'], ['LNW-22', 'Lenin', 'The Awakening of Asia'],
  ['LNW-23', 'Nkrumah', 'Class Struggle in Africa'], ['LNW-24', 'Abt', 'Who Has the Right to Make War'], ['LNW-25', 'Aronson', 'Packaging the News'],
  ['LNW-26', 'Foner', 'American Labor and the Indochina War'], ['LNW-27', 'Meyer', 'Native Americans'], ['LNW-28', 'Pomeroy', 'Apartheid Axis'],
  ['LNW-29', 'Cornforth', 'Materialism and the Dialectical Method'], ['LNW-30', 'Cornforth', 'Historical Materialism'], ['LNW-31', 'Cornforth', 'The Theory of Knowledge'],
  ['LNW-33', 'Hall', 'Ecology'], ['LNW-35', 'Cornforth', 'Communism and Human Values'], ['LNW-36', 'Leontyev', 'Political Economy'],
  ['LNW-37', 'Lowenfels', 'The Revolution Is to Be Human'], ['LNW-38', 'Myerson', 'Watergate'], ['LNW-39', 'Hall', 'The Energy Rip-Off'],
];
const seriesKey = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Series volume lists (data/series/*.yaml): a house's edition that is a recorded volume — the same
// LCCN, or the same title and year — takes the series and its number.
const SERIES_LISTS = readdirSync(join(ROOT, 'data', 'series')).filter((f) => /\.ya?ml$/.test(f))
  .map((f) => yaml.load(readFileSync(join(ROOT, 'data', 'series', f), 'utf8')));

function seriesFromLists(t, publisherId) {
  for (const list of SERIES_LISTS) {
    if (list.publisher !== publisherId) continue;
    const lccns = new Set((t.sources ?? []).map((s) => String(s.url ?? '').match(/lccn\.loc\.gov\/(\w+)/)?.[1]).filter(Boolean));
    const key = seriesKey(t.title);
    const vol = list.volumes.find((v) => (v.lccn && lccns.has(String(v.lccn)))
      || (v.year && v.year === t.year && key && (key.startsWith(seriesKey(v.title)) || seriesKey(v.title).startsWith(key))));
    if (vol) return vol.number ? `${list.name}, ${vol.number}` : list.name;
  }
  return undefined;
}

/** The checklist number for a record of the series that lacks one, when one entry matches. */
function seriesNumber(t) {
  const m = /^(Little )?New World Paperbacks$/.exec(t.series ?? '');
  if (!m) return t.series;
  const little = Boolean(m[1]);
  const title = seriesKey(t.title);
  const credits = seriesKey((t.authors ?? []).concat(t.editors ?? []).join(' '));
  const hits = SERIES_CHECKLIST.filter(([n, surname, start]) => n.startsWith('LNW') === little
    && title.startsWith(seriesKey(start)) && (!credits || credits.includes(seriesKey(surname))));
  return hits.length === 1 ? `${t.series}, ${hits[0][0]}` : t.series;
}

/**
 * International Publishers' paperback series under one spelling with the number in one form:
 * "New World paperbacks -- NW-24", "New World Paperbacks, 63" → "New World Paperbacks, NW-24", "… NW-63".
 */
function normaliseSeries(series) {
  const m = series.match(/^(little\s+)?new\s+world\s+paperbacks?\b[\s,;:.\-–—]*(.*)$/i);
  if (!m) return series;
  const name = m[1] ? 'Little New World Paperbacks' : 'New World Paperbacks';
  const prefix = m[1] ? 'LNW' : 'NW';
  let number = m[2].trim().toUpperCase().replace(/^(NO\.?|NUMBER)\s*/, '').replace(/^LNI-/, 'LNW-').replace(/\s+/g, '');
  // CiNii's forms: "0614-6", "NW 64 . CAPITAL : A CRITIQUE…" (a part number and a sub-series).
  number = number.replace(/\..*$/, '').replace(/^(L?NW)(?=\d)/, '$1-').replace(/^(L?NW-)0+(?=\d)/, '$1');
  if (/^\d/.test(number)) number = `${prefix}-${number.replace(/^0+(?=\d)/, '')}`;
  if (/^S-?\d+$/.test(number)) number = `${prefix}-${number.replace(/^S-?/, 'S-')}`;
  return number ? `${name}, ${number}` : name;
}

const LANGUAGE_BY_NAME = new Map(Object.values(LANGUAGES).map((n) => [n.toLowerCase(), n]));
// The language of a house's own books, by its MARC country code (for the correction in toExternalTitle).
const HOUSE_LANGUAGE = { hu: 'Hungarian', xr: 'Czech', cs: 'Czech', pl: 'Polish', bu: 'Bulgarian', rm: 'Romanian', ru: 'Russian', ur: 'Russian' };

function toExternalTitle(rec, rule, verdict) {
  const langs = rec.languageNames
    .map((l) => LANGUAGES[String(l).toLowerCase()] ?? LANGUAGE_BY_NAME.get(String(l).toLowerCase()))
    .filter(Boolean)
    // As in library records, Galician items are often tagged only "Romance (Other)".
    .map((l) => (l === 'Romance' && /gal(ego|ega|iza|icia)|gallego/i.test(rec.title ?? '') ? 'Galician' : l));
  // Scan titles sometimes carry the year: "The First and Last Freedom (1954)".
  const title = clean(String(rec.title ?? '').replace(/\s*\(\s*(1[89]|20)\d\d\s*\)\s*$/, '')) ?? '[Untitled]';
  // A title catalogued as English but written in another language takes that language.
  const recorded = langs.length ? [...new Set(langs)].join(', ') : 'Not recorded';
  let language = recorded === 'English' ? foreignTitleLanguage(title) ?? recorded : recorded;
  // The German National Library codes many of its older East European books as German ("A
  // szocializmus fejlődése…", 1945): for such a house, a title with no German in it takes the house's language.
  if (rec.source === 'German National Library' && language === 'German') {
    const home = (rule.country ?? []).map((c) => HOUSE_LANGUAGE[c]).find(Boolean);
    if (home && !/(^|\s)(der|die|das|und|des|den|dem|zur|zum|im|für|über|von|mit|ein|eine|einer)(\s|$)/i.test(title)) language = home;
  }
  const english = isEnglishTitle(title, language === 'Not recorded' ? undefined : language);
  const options = { eastAsian: EAST_ASIAN_HOUSES.has(rule.id), showNative: REGIONAL_LANGUAGE_HOUSES.has(rule.id) };
  // "Le Duan of the Vietnam Workers' Party" → "Le Duan".
  const creators = rec.creators.map((c) => String(c).replace(/\s+of\s+the\s+.*$/i, ''));
  const authors = [...new Set(creators.map((c) => displayAuthor(c, [], options)).filter(Boolean))]
    .filter((a) => !rule.match.test(a) && !/publishing house|foreign languages/i.test(a));
  const isScan = rec.source === 'Internet Archive';
  const t = {
    title: formatTitle(title, english, language),
    subtitle: formatTitle(clean(rec.subtitle), english, language),
    series: rec.series ? formatTitle(clean(rec.series), english, language) : undefined,
    authors,
    year: yearOf(rec.publish_date),
    language,
    // Library catalogues may point to their own digitised copy; addFreeAccess keeps it only if open.
    links: rec.catalogued
      ? (rec.digital ? [{ label: 'Digitised copy', url: rec.digital }] : [])
      : [{ label: isScan ? 'Scan (Internet Archive)' : 'PDF (BannedThought.net)', url: rec.url }],
    sources: rec.catalogued
      ? [
          { title: rec.recordLabel, url: rec.url },
          // Cited so the free-copy check can find a HathiTrust scan by OCLC number.
          ...(rec.oclc ? [{ title: `WorldCat record (OCLC ${rec.oclc})`, url: `https://search.worldcat.org/title/${rec.oclc}` }] : []),
          // CiNii records cite the Library of Congress record they were copied from.
          ...(rec.lccn ? [{ title: `Library of Congress record (LCCN ${rec.lccn})`, url: `https://lccn.loc.gov/${rec.lccn}` }] : []),
        ]
      : [{ title: isScan ? `Internet Archive item ${rec.key.slice(3)}` : 'BannedThought.net', url: isScan ? rec.url : rec.pageUrl }],
    verified: Boolean(rec.catalogued && verdict === 'match' && yearOf(rec.publish_date)),
  };
  if (!t.year) delete t.year;
  if (!t.subtitle) delete t.subtitle;
  if (!t.links.length) delete t.links;
  return t;
}

console.log('Cross-referencing the Internet Archive and BannedThought.net…');
const externalRecords = [...(await bannedThoughtItems())];
const iaTerms = new Set(PUBLISHERS.flatMap((p) => p.search));
for (const term of iaTerms) {
  externalRecords.push(...(await internetArchiveItems(term)));
  checkBudget();
}

// National library catalogues, each searched for the houses of its region. Their records are
// library-catalogued, so matches are verified like Open Library's MARC records.
const termsOf = (ids) => PUBLISHERS.filter((p) => ids.includes(p.id)).flatMap((p) => p.search);
const LIBRARY_SEARCHES = [
  ['German National Library', dnbRecords, [
    ...termsOf(['militarverlag-der-ddr', 'staatsverlag-der-ddr', 'verlag-tribune', 'verlag-zeit-im-bild', 'panorama-ddr',
      'dietz-verlag', 'jhw-dietz', 'carl-hoym-verlag', 'viva', 'verlag-fur-literatur-und-politik',
      'volksbuchhandlung-hottingen-zurich', 'buchhandlung-vorwarts', 'wiener-volksbuchhandlung', 'malik-verlag',
      'cooperative-publishing-society-of-foreign-workers', 'verlag-roter-morgen', 'verlag-marxistische-blatter',
      'pahl-rugenstein', 'verlag-neuer-weg', 'globus-verlag']),
    'Verlag für fremdsprachige Literatur', 'Verlag Progress', 'Verlag der Agentur Nowosti',
  ]],
  ['Bibliothèque nationale de France', bnfRecords, [
    ...termsOf(['editions-sociales', 'librairie-de-l-humanite', 'editions-maspero', 'bureau-d-editions',
      'editions-du-centenaire', 'epo', 'remarques-congolaises', 'parti-communiste-algerien', 'alger-republicain', 'pags',
      'parti-communiste-tunisien', 'perspectives-tunisiennes', 'dan-chung', 'la-lutte-saigon', 'librairie-du-travail']).filter((t) => t !== 'La Découverte'), // its modern list is outside the Maspero years
    'Éditions en langues étrangères', 'Éditions du Progrès', "Éditions de l'Agence de presse Novosti",
  ]],
  // Search terms may carry a year range: [term, from, until].
  // The National Library of Poland: the Polish socialist, communist and state political presses, the
  // Kultur-Lige, and the foreign workers' cooperative's Polish editions.
  ['National Library of Poland', polishRecords, [
    ...termsOf(['ksiazka-i-wiedza', 'ksiazka-1918', 'robotnik-pps', 'wydawnictwo-mon', 'interpress', 'kultur-lige']),
    'Towarzystwo Wydawnicze Robotników Zagranicznych',
  ]],
  ['National Diet Library', ndlRecords, [
    ...['希望閣', '共生閣', 'マルクス書房', '白揚社'].flatMap((t) => Array.from({ length: 26 }, (_, i) => [t, 1920 + i, 1920 + i])),
    ...Array.from({ length: new Date().getFullYear() - 1956 }, (_, i) => ['新日本出版社', 1957 + i, 1957 + i]),
  ]],
];
// The Library of Congress, searched by keyword: the houses of Puerto Rico, the liberation movements,
// the Soviet republics and the émigré presses, which Open Library holds few records of.
LIBRARY_SEARCHES.push(['Library of Congress', locRecords, termsOf([
  'partido-socialista-puertorriqueno', 'liga-socialista-puertorriquena', 'movimiento-socialista-de-trabajadores', 'taller-de-formacion-politica',
  'mpla', 'zapu', 'tupamaros', 'partido-comunista-del-peru', 'committee-to-support-the-revolution-in-peru', 'fsln', 'wesanen-serxwebun',
  'publishing-house-of-the-communist-international', 'red-international-of-labour-unions-press', 'publishing-house-of-the-young-communist-international',
  'mopr-verlag', 'for-a-lasting-peace', 'peace-and-socialism-publishers',
  'derzhavne-vydavnytstvo-ukrainy', 'proletarii-kharkiv', 'partvydav-ukrainy', 'ukrainskyi-robitnyk', 'belaruskae-dziarzhaunae-vydavetstva',
  'sakhelgami', 'haypethrat', 'azgiz', 'uzgiz', 'kazgiz', 'turkmengosizdat', 'tadzhikgosizdat', 'kirgizgosizdat',
  'social-democrat-hunchakian-party', 'bund-foreign-committee', 'prometejs',
  'daily-worker-publishing-company', 'communist-party-usa', 'masses-and-mainstream', 'black-panther-party', 'line-of-march', 'socialist-party-of-america',
  'communist-party-of-canada', 'en-lutte', 'socialist-party-of-canada', 'vanguard-publications', 'new-hogtown-press', 'editions-parti-pris',
  'partido-comunista-mexicano', 'ediciones-frente-cultural', 'universidad-obrera-de-mexico', 'partido-popular-socialista',
  'psuc', 'editorial-marxista-poum',
])]);
// International Publishers' paperback series, which the Library of Congress records in its series fields.
LIBRARY_SEARCHES.at(-1)[2].push('New World paperbacks', 'Little New World paperbacks');
// The French university libraries (SUDOC) for the French and Belgian houses, and the Swiss academic
// libraries (swisscovery) for the German-language houses: the national libraries' searches again.
LIBRARY_SEARCHES.push(['SUDOC', sudocRecords, LIBRARY_SEARCHES[1][2]]);
LIBRARY_SEARCHES.push(['swisscovery', swissRecords, LIBRARY_SEARCHES[0][2]]);
// The internationals' German and French houses, and the PKK's press in Cologne.
LIBRARY_SEARCHES[0][2].push(...termsOf(['publishing-house-of-the-communist-international', 'publishing-house-of-the-young-communist-international', 'mopr-verlag', 'wesanen-serxwebun']));
LIBRARY_SEARCHES[1][2].push(...termsOf(['publishing-house-of-the-communist-international', 'mpla', 'social-democrat-hunchakian-party', 'psuc', 'editorial-marxista-poum']));
// Houses with few titles on file — party presses and liberation movements, mostly — are searched in
// every catalogue, not only their region's: their pamphlets are scattered across the world's libraries.
const titlesOnFile = (id) => {
  const dir = join(CATALOGUES, id);
  const files = statSync(dir, { throwIfNoEntry: false })?.isDirectory()
    ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => join(dir, f))
    : [`${dir}.yaml`].filter((f) => statSync(f, { throwIfNoEntry: false }));
  // Only titles with an Open Library record count: those the library searches add would otherwise
  // lift a house past the threshold, and the next run, no longer searching for it, would drop them.
  const fromOpenLibrary = (t) => (t.sources ?? []).some((s) => /^Open Library/.test(s.title ?? ''));
  return files.reduce((n, f) => n + (yaml.load(readFileSync(f, 'utf8'))?.titles ?? []).filter(fromOpenLibrary).length, 0);
};
const THIN = PUBLISHERS.filter((p) => p.search.length && titlesOnFile(p.id) < 15).map((p) => p.id);
for (const search of LIBRARY_SEARCHES) if (search[1] !== ndlRecords) search[2].push(...termsOf(THIN));
// The Soviet and Chinese state houses, of whose output Open Library holds a fraction. SUDOC records
// Russian imprints in ISO 9 romanisation ("Molodaâ gvardiâ") and Chinese ones as the Library of
// Congress does ("Ren min chu ban she"); the Library of Congress's search finds Chinese imprints but
// hardly any Russian ones. Large houses are searched year by year, under each catalogue's cap on a search.
const rangeOf = (id) => PUBLISHERS.find((p) => p.id === id).years;
const yearly = (terms, [from, until], last = 1991) =>
  terms.flatMap((t) => Array.from({ length: Math.max(0, Math.min(until, last) - from + 1) }, (_, i) => [t, from + i]));
const SOVIET_ISO = {
  politizdat: ['Politizdat', 'Gospolitizdat', 'Partizdat'], 'progress-publishers': ['Progress'],
  'foreign-languages-publishing-house-moscow': ['Izdatelʹstvo literatury na inostrannyh âzykah'],
  'sovetskii-pisatel': ['Sovetskij pisatel'], 'khudozhestvennaia-literatura': ['Hudožestvennaâ literatura', 'Goslitizdat'],
  'molodaia-gvardiia': ['Molodaâ gvardiâ'], 'detskaia-literatura': ['Detskaâ literatura', 'Detgiz'], mysl: ['Mysl'],
  lenizdat: ['Lenizdat'], 'moskovskii-rabochii': ['Moskovskij rabočij'], profizdat: ['Profizdat'], voenizdat: ['Voenizdat'],
  'sovetskaia-rossiia': ['Sovetskaâ Rossiâ'], 'izdatelstvo-pravda': ['Pravda'], 'raduga-publishers': ['Raduga'], gosizdat: ['Gosizdat'],
};
const CHINESE = PUBLISHERS.filter((p) => p.country?.includes('cc')).map((p) => p.id);
const CHINESE_LARGE = ['Ren min chu ban she', 'Foreign Languages Press', 'Wai wen chu ban she'];
LIBRARY_SEARCHES.push(['SUDOC (Soviet and Chinese houses)', (t, y) => sudocRecords(t, 'edi', y), [
  ...Object.entries(SOVIET_ISO).flatMap(([id, terms]) => yearly(terms, rangeOf(id))),
  ...yearly(['Ren min chu ban she'], [1950, 1990]),
  ...termsOf(CHINESE).filter((t) => t !== 'Ren min chu ban she'),
]]);
LIBRARY_SEARCHES.push(['Library of Congress (Chinese houses)', (t, y) => locRecords(t, 10, y), [
  ...yearly(['Ren min chu ban she'], [1950, 1990]),
  ...yearly(['Foreign Languages Press', 'Wai wen chu ban she'], [1952, new Date().getFullYear()], new Date().getFullYear()),
  ...termsOf(CHINESE).filter((t) => !CHINESE_LARGE.includes(t)),
]]);
// The state houses of Korea, Vietnam, Laos and the Warsaw Pact countries, searched year by year in
// the catalogues that hold their books in Latin script: the Library of Congress and SUDOC, and the
// German National Library for the Warsaw Pact houses.
const ASIAN_STATE = {
  'workers-party-of-korea-publishing-house': ["Chosŏn Rodongdang Ch'ulp'ansa"],
  'literature-and-art-publishing-house-pyongyang': ["Munye Ch'ulp'ansa", "Munhak Yesul Chonghap Ch'ulp'ansa"],
  'kumsong-youth-publishing-house': ["Kŭmsŏng Ch'ŏngnyŏn Ch'ulp'ansa"], 'sahoe-kwahak-chulpansa': ["Sahoe Kwahak Ch'ulp'ansa"],
  'kullo-tanche-chulpansa': ["Kŭllo Tanch'e Ch'ulp'ansa"], 'kwahak-paekkwa-sajon-chulpansa': ["Kwahak Paekkwa Sajŏn Ch'ulp'ansa"],
  'su-that': ['Sự thật'], 'quan-doi-nhan-dan': ['Quân đội nhân dân'], 'lao-dong-hanoi': ['Lao động'],
  'van-hoc-hanoi': ['Văn học'], 'thanh-nien-hanoi': ['Thanh niên'], 'khoa-hoc-xa-hoi-hanoi': ['Khoa học xã hội'],
  'lao-state-publishing-house': ['Samnakphim Chamnai'], 'lao-state-printing-house': ['Hongphim haeng Lat'],
};
const WARSAW_PACT = {
  'kossuth-konyvkiado': ['Kossuth', 'Szikra'], svoboda: ['Svoboda', 'Nakladatelství politické literatury'],
  'editura-politica': ['Editura Politică'], 'ksiazka-i-wiedza': ['Książka i Wiedza'], 'partizdat-sofia': ['Partizdat'],
  'dietz-verlag': ['Dietz Verlag'],
};
const followUp = (map) => Object.entries(map).flatMap(([id, terms]) => yearly(terms, rangeOf(id)));
LIBRARY_SEARCHES.push(['Library of Congress (Asian and Warsaw Pact state houses)', (t, y) => locRecords(t, 10, y), followUp({ ...ASIAN_STATE, ...WARSAW_PACT })]);
LIBRARY_SEARCHES.push(['SUDOC (Asian and Warsaw Pact state houses)', (t, y) => sudocRecords(t, 'edi', y), followUp({ ...ASIAN_STATE, ...WARSAW_PACT })]);
LIBRARY_SEARCHES.push(['German National Library (Warsaw Pact state houses)', (t, y) => dnbRecords(t, 'vlg', y), followUp(WARSAW_PACT)]);
// The Cuban, Mozambican and Angolan state houses, in the Library of Congress and SUDOC; each holds
// fewer of their books than a single search's cap, so they are searched by name alone.
const AMERICAS_AFRICA = ['editorial-nacional-de-cuba', 'instituto-cubano-del-libro', 'editorial-arte-y-literatura', 'editorial-letras-cubanas',
  'editorial-gente-nueva', 'editorial-pueblo-y-educacion', 'casa-de-las-americas', 'ediciones-union', 'editora-abril', 'editorial-oriente',
  'editorial-jose-marti', 'inld-mozambique', 'inald-angola'];
LIBRARY_SEARCHES.push(['Library of Congress (Cuban and African state houses)', locRecords, termsOf(AMERICAS_AFRICA)]);
LIBRARY_SEARCHES.push(['SUDOC (Cuban and African state houses)', sudocRecords, termsOf(AMERICAS_AFRICA)]);
// The affirmed Marxist houses: the Library of Congress and SUDOC for all, and the German National
// Library and swisscovery for the German and Austrian ones.
const MARXIST = MARXIST_HOUSES.map((h) => h[0]);
const GERMAN_MARXIST = MARXIST_HOUSES.filter((h) => ['Germany', 'Austria'].includes(h[3])).map((h) => h[0]);
LIBRARY_SEARCHES.push(['Library of Congress (Marxist houses)', locRecords, termsOf(MARXIST)]);
LIBRARY_SEARCHES.push(['SUDOC (Marxist houses)', sudocRecords, termsOf(MARXIST)]);
LIBRARY_SEARCHES.push(['German National Library (Marxist houses)', dnbRecords, termsOf(GERMAN_MARXIST)]);
LIBRARY_SEARCHES.push(['swisscovery (Marxist houses)', swissRecords, termsOf(GERMAN_MARXIST)]);
// Houses whose name-only searches fill a catalogue's cap with other publishers' books (Kultura,
// Rad, Prosveta) or with their own, searched again year by year.
const DEEP = {
  'kultura-belgrade': ['Kultura'], 'rad-belgrade': ['Rad'], 'prosveta-belgrade': ['Prosveta'], 'borba-belgrade': ['Borba'],
  komunist: ['Komunist'], '8-nentori': ['8 Nëntori'], 'naim-frasheri': ['Naim Frashëri'], 'dar-al-farabi': ['Dār al-Fārābī'],
  'editorial-nueva-nicaragua': ['Nueva Nicaragua'], 'national-book-agency': ['National Book Agency'], 'kuraz-publishing-agency': ['Kuraz'],
};
const deepTerms = (ids) => Object.entries(DEEP).filter(([id]) => ids.includes(id)).flatMap(([id, terms]) => yearly(terms, rangeOf(id), 2025));
const BALKAN_DEEP = ['kultura-belgrade', 'rad-belgrade', 'prosveta-belgrade', 'borba-belgrade', 'komunist', '8-nentori', 'naim-frasheri'];
LIBRARY_SEARCHES.push(['Library of Congress (houses searched by year)', (t, y) => locRecords(t, 10, y), deepTerms(Object.keys(DEEP))]);
LIBRARY_SEARCHES.push(['SUDOC (houses searched by year)', (t, y) => sudocRecords(t, 'edi', y), deepTerms(Object.keys(DEEP))]);
LIBRARY_SEARCHES.push(['German National Library (houses searched by year)', (t, y) => dnbRecords(t, 'vlg', y), deepTerms(BALKAN_DEEP)]);
// Two German union catalogues, K10plus (with the Berlin State Library) and B3Kat (with the Bavarian
// State Library), which hold the West's largest Slavic, East European and Chinese collections, and
// Spain's national library, searched for every house. They romanise Russian by DIN 1460
// ("Molodaja gvardija"), not as the Library of Congress does ("Molodaia gvardiia"), so the Soviet
// houses' names are searched in both forms. A name with more records than one search returns is
// searched year by year over the house's years; a name with none is not searched.
console.log(`Counting each house's records in K10plus, B3Kat and the Biblioteca Nacional de España (${unionYears.size} names)…`);
LIBRARY_SEARCHES.push(['K10plus', k10plusRecords, await slicedTerms(k10plusCount, 10000)]);
LIBRARY_SEARCHES.push(['B3Kat', b3katRecords, await slicedTerms(b3katCount, 5000)]);
LIBRARY_SEARCHES.push(['Biblioteca Nacional de España', bneRecords, await slicedTerms(bneCount, 2000)]);
// Every house in every catalogue: the searches above cover each house in its own region's
// catalogues (and the thin houses everywhere); the rest of each house's names are searched in each
// catalogue once more, so no house is missing from a catalogue only because it was not asked.
const plainTerm = (t) => String(Array.isArray(t) ? t[0] : t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
for (const [catalogue, fetchRecords] of [['German National Library', dnbRecords], ['Bibliothèque nationale de France', bnfRecords],
  ['Library of Congress', locRecords], ['SUDOC', sudocRecords], ['swisscovery', swissRecords], ['National Library of Poland', polishRecords]]) {
  const asked = new Set(LIBRARY_SEARCHES.filter(([name]) => name.split(' (')[0] === catalogue).flatMap(([, , terms]) => terms.map(plainTerm)));
  const rest = [...new Set(PUBLISHERS.flatMap((p) => p.search))].filter((t) => !asked.has(plainTerm(t)));
  LIBRARY_SEARCHES.push([`${catalogue} (all other houses)`, fetchRecords, rest]);
}
console.log(`Searching national library catalogues (${THIN.length} houses with few titles in all of them)…`);
const externalAdded = {};
const seenExternal = new Set();
// Periodical issues ("Monthly Review 1952-10: Vol 4 Iss 6") and bare volume numbers ("Volume 41")
// are not books, or cannot be identified as one.
const NOT_A_BOOK = /\bvol\.?\s*\d+\s*,?\s*(iss(ue)?|no)\.?\s*\d+|^\s*vol(ume)?\.?\s*\d+\s*$|^\S+\s+\d{4}-\d{2}\b/i;
/** Gives each record to the first house it belongs to. Records are matched as they are fetched and
 * not kept, so the catalogues' hundreds of thousands of records need not be held at once. */
// Most records the union catalogues find are further copies of titles already on file; a house's
// list is merged as it grows (as it is again at the end), so the copies are not all held at once.
const compactedAt = new Map();
function compact(id) {
  const titles = byPublisher.get(id);
  if (titles.length < 2000 || titles.length < 1.5 * (compactedAt.get(id) ?? 0)) return;
  const merged = dedupe(titles);
  byPublisher.set(id, merged);
  compactedAt.set(id, merged.length);
}
function matchRecords(recs) {
  for (const rec of recs) {
    if (seenExternal.has(rec.key) || NOT_A_BOOK.test(String(rec.title ?? ''))) continue;
    seenExternal.add(rec.key);
    for (const rule of PUBLISHERS) {
      const verdict = judge(rec, rule);
      if (verdict !== 'match' && verdict !== 'match-no-place') continue;
      const t = toExternalTitle(rec, rule, verdict);
      if (!rule.exclude?.(t)) {
        byPublisher.get(rule.id).push(t);
        externalAdded[rec.source] = (externalAdded[rec.source] ?? 0) + 1;
        compact(rule.id);
      }
      break;
    }
  }
}
matchRecords(externalRecords);
externalRecords.length = 0;
for (const [name, fetchRecords, terms] of LIBRARY_SEARCHES) {
  let n = 0;
  // Library searches ignore accents and case, so "Éditions sociales" and "Editions sociales" are one search.
  const unique = [...new Map(terms.map((t) => [JSON.stringify(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(), t])).values()];
  for (const term of unique) {
    const recs = await fetchRecords(...[].concat(term));
    n += recs.length;
    matchRecords(recs);
    checkBudget();
  }
  console.log(`  ${name}: ${n} records`);
}
// HathiTrust, read from its monthly listing of every item (the Hathifiles) rather than searched:
// the scanned collections of its member libraries, with the pamphlets of Michigan's Labadie
// Collection and Wisconsin's, and a full-view link for those open to all. Only imprints with the
// most distinctive word of one of the houses' names are judged by the rules.
{
  const wanted = hathiFilter();
  let n = 0;
  for await (const batch of hathiRecords(wanted)) { n += batch.length; matchRecords(batch); }
  console.log(`  HathiTrust (Hathifiles): ${n} records`);
}
console.log(`  records matched: ${Object.entries(externalAdded).map(([k, v]) => `${k} ${v}`).join(', ')} (${sourceRequests} requests)`);

// CiNii Books, searched by each house's names. Its search results are brief, so a full record is
// fetched only for a title the house's records lack. CiNii gives no place of publication, so a
// title is verified only when its record cites the Library of Congress record it was copied from.
// CiNii records Russian and Chinese imprints in their own scripts ("Политиздат", "人民出版社"), which
// the houses' romanised search terms do not find. The names in Cyrillic or Chinese characters are
// taken from each house's matching rule, with the forms the rules leave to a pattern added here.
const NATIVE_EXTRA = {
  politizdat: ['Изд-во полит. лит-ры'], 'progress-publishers': ['Прогресс'], 'sovetskii-pisatel': ['Советский писатель'],
  'khudozhestvennaia-literatura': ['Художественная литература'], 'molodaia-gvardiia': ['Молодая гвардия'],
  'detskaia-literatura': ['Детская литература'], 'foreign-languages-publishing-house-moscow': ['Изд-во лит-ры на иностранных языках'],
  'dushu-chubanshe': ['读书生活出版社', '读书出版社', '讀書生活出版社'],
  // Korean names the rules give as patterns ("문학예술(종합)?출판사").
  'foreign-languages-publishing-house-pyongyang': ['외국문출판사', '외국문종합출판사'],
  'literature-and-art-publishing-house-pyongyang': ['문학예술종합출판사', '문학예술출판사'],
  'korean-writers-union-publishing-house': ['조선작가동맹출판사'], 'kwahak-paekkwa-sajon-chulpansa': ['과학백과사전종합출판사'],
};
// Fragments of alternations ("изд(-во|ательство)") rather than names.
const NOT_A_NAME = new Set(['ательство', 'полит', 'издательство', 'изд', 'искр']);
function nativeNames(rule) {
  const src = rule.match.source;
  // Only whole names: a run touching a bracket or a quantifier is a fragment of a pattern such as
  // "读书(生活)?出版社", and a fragment like "出版社" ("publishing house") would search every publisher.
  const whole = (re) => [...src.matchAll(re)].filter((m) => {
    const before = src[m.index - 1] ?? '^';
    const end = m.index + m[0].length;
    const after = src[end] ?? '$';
    // Starts an alternative: after "^", "|", or a "(" that does not follow a letter ("изд(-во").
    if (!'^|('.includes(before) || (before === '(' && /\p{L}/u.test(src[m.index - 2] ?? ''))) return false;
    // Ends one: before "|", ")" (unless the group is optional) or the end of the pattern.
    return '|)$'.includes(after) && !(after === ')' && /[?*]/.test(src[end + 1] ?? ''));
  }).map((m) => m[0]);
  // Chinese characters, Hangul, Lao and Khmer.
  const cjk = whole(/[㐀-鿿가-힣຀-໿ក-៿][㐀-鿿가-힣຀-໿ក-៿·・]*[㐀-鿿가-힣຀-໿ក-៿]/gu);
  // Cyrillic words (with the Ukrainian and Belarusian letters), joined where the pattern spaces them.
  const cyrillic = whole(/[а-яёіїєґў][а-яёіїєґў'ʼ-]*(?:\\s[+*]?[«"„]?[а-яёіїєґў][а-яёіїєґў'ʼ-]*)*/giu)
    .map((s) => s.replace(/\\s[+*]?[«"„]?/g, ' '));
  const seen = new Set(rule.search.map((t) => t.toLowerCase()));
  return [...cjk, ...cyrillic, ...(NATIVE_EXTRA[rule.id] ?? [])].filter((n) => {
    const k = n.toLowerCase();
    if (n.length < 3 || NOT_A_NAME.has(k) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
console.log('Searching CiNii Books…');
let ciniiAdded = 0;
// Houses that both list a shared imprint's titles on purpose: the foreign workers' cooperative
// (1930–1939) is also the first stage of the Foreign Languages Publishing House.
const LINEAGES = [['cooperative-publishing-society-of-foreign-workers', 'foreign-languages-publishing-house-moscow']];
const sameLineage = (a, b) => LINEAGES.some((l) => l.includes(a) && l.includes(b));
// Each house's titles with their years ("selected works|1972": a title alone, such as "Selected
// Works", recurs across houses), built on first use and kept up to date as CiNii adds titles.
const yearKey = (title, year) => `${titleKey(title)}|${year ?? ''}`;
const keysByHouse = new Map();
const keysOf = (id) => keysByHouse.get(id) ?? keysByHouse.set(id, new Set(byPublisher.get(id).map((t) => yearKey(t.title, t.year)))).get(id);
/** The titles one CiNii search adds to a house, and the title keys it has seen. */
async function ciniiTerm(rule, term, have) {
  const added = [], seen = new Set();
  // A search past CiNii's cap of 5,000 records is made year by year; one finding more than
  // 60,000 is too general to be a house's name and is skipped.
  const total = await ciniiTotal(term);
  if (total > 60000) { console.log(`  skipped "${term}" (${total} records)`); return { added, seen }; }
  const lastYear = Math.min(rule.years[1], new Date().getFullYear());
  const years = total > 4800 ? Array.from({ length: lastYear - rule.years[0] + 1 }, (_, i) => rule.years[0] + i) : [undefined];
  const items = [];
  for (const y of years) items.push(...await ciniiSearch(term, 'publisher', y));
  for (const item of items) {
    const imprints = item.publishers.map((p) => String(p).trim()).filter((p) => rule.match.test(p));
    if (!imprints.length) continue;
    if (!item.year || item.year < rule.years[0] || item.year > rule.years[1]) continue;
    // CiNii gives no place, so an imprint two houses share in that year ("J. H. W. Dietz Nachf.",
    // East Berlin or Bonn) cannot be placed by it: a title another such house already lists, from a
    // catalogue that records the place, is left to that house.
    const ck = yearKey(String(item.title).split(/\s+:\s+/)[0], item.year);
    if (PUBLISHERS.some((o) => o !== rule && !sameLineage(o.id, rule.id) && item.year >= o.years[0] && item.year <= o.years[1]
      && imprints.some((p) => o.match.test(p)) && keysOf(o.id).has(ck))) continue;
    const k = titleKey(String(item.title).split(/\s+:\s+/)[0]);
    if (!k || have.has(k) || seen.has(k)) continue;
    seen.add(k);
    const rec = await ciniiRecord(item);
    if (!rec) continue;
    const t = toExternalTitle(rec, rule, rec.lccn ? 'match' : 'match-no-place');
    if (!rule.exclude?.(t)) added.push(t);
  }
  return { added, seen };
}
for (const rule of PUBLISHERS) {
  const have = new Set(byPublisher.get(rule.id).map((t) => titleKey(t.title)));
  for (const term of [...rule.search, ...nativeNames(rule)]) {
    for (let attempt = 0; ; attempt++) {
      try {
        const { added, seen } = await ciniiTerm(rule, term, have);
        for (const k of seen) have.add(k);
        byPublisher.get(rule.id).push(...added);
        for (const t of added) keysOf(rule.id).add(yearKey(t.title, t.year));
        ciniiAdded += added.length;
        break;
      } catch (e) {
        // CiNii refuses a client that has searched too much (HTTP 403). The rest of the stage then
        // uses only the cached responses, as with --offline=ci.nii.ac.jp, and the search is redone
        // from the cache; a later run fills in what is missing.
        if (attempt || !/HTTP 403/.test(String(e?.message))) throw e;
        process.env.LEFT_BACKLIST_OFFLINE = [process.env.LEFT_BACKLIST_OFFLINE, 'ci.nii.ac.jp'].filter(Boolean).join(',');
        console.log(`  CiNii refused further searches at ${rule.id} ("${term}"); continuing from the cache only`);
      }
    }
    checkBudget();
  }
}
console.log(`  CiNii Books: ${ciniiAdded} titles added`);

let duplicatesMerged = 0;
for (const [id, titles] of byPublisher) {
  const merged = absorbUndated(dedupe(titles));
  duplicatesMerged += titles.length - merged.length;
  byPublisher.set(id, merged);
}
console.log(`  ${duplicatesMerged} duplicate records merged`);

// Where two houses list the same edition, the more specific house keeps it: a Left Book Club
// Choice is also a Gollancz book, and post-1945 "Dietz" records belong to the East Berlin house.
const handTitlesByPublisher = new Map();
for (const { doc } of loadHandFiles()) {
  handTitlesByPublisher.set(doc.publisher, [...(handTitlesByPublisher.get(doc.publisher) ?? []), ...doc.titles]);
}
let yielded = 0;
for (const rule of PUBLISHERS.filter((p) => p.yieldTo)) {
  const others = rule.yieldTo.flatMap((id) => [...(byPublisher.get(id) ?? []), ...(handTitlesByPublisher.get(id) ?? [])]);
  const own = byPublisher.get(rule.id);
  const kept = own.filter((t) => !others.some((o) => o.year === t.year && titlesMatch(o, t) && authorsOverlap(o.authors, t.authors)));
  yielded += own.length - kept.length;
  byPublisher.set(rule.id, kept);
}
console.log(`  ${yielded} editions left to the more specific house`);

// Hand-entered titles: match against imports first, then look each one up individually.
console.log('Verifying hand-entered titles…');
const handReport = [];
const handPatches = new Map();
for (const { file, doc } of loadHandFiles()) {
  const pubId = doc.publisher;
  const rule = PUBLISHERS.find((p) => p.id === pubId) ?? (VERIFY_ONLY[pubId] && { id: pubId, ...VERIFY_ONLY[pubId] });
  if (!rule) continue;

  for (const [index, hand] of doc.titles.entries()) {
    const label = `${hand.title} (${hand.year ?? 'n.d.'})`;
    let sources;

    // The hand-entered record supersedes any imported record of the same edition.
    const imported = byPublisher.get(pubId) ?? [];
    const duplicates = imported.filter(
      (t) => (t.year === hand.year || !t.year) && titlesMatch(hand, t) && authorsOverlap(hand.authors, t.authors),
    );
    if (duplicates.length) byPublisher.set(pubId, imported.filter((t) => !duplicates.includes(t)));
    const verifiedDuplicates = duplicates.filter((t) => t.verified);
    if (verifiedDuplicates.length) {
      sources = verifiedDuplicates.flatMap((t) => t.sources);
    } else {
      const { exact, near } = await verifyHandTitle(hand, rule);
      if (exact.length) {
        await resolveAuthors(exact.flatMap((ed) => (ed.authors ?? []).map((a) => a.key)));
        sources = exact.flatMap((ed) => toTitle(ed, rule).sources);
      } else {
        const hint = near.length
          ? `closest catalogue records: ${near.slice(0, 3).map((ed) => `${(ed.publishers ?? []).join('/')}, ${ed.publish_date ?? 'n.d.'} <${OL}${ed.key}>`).join('; ')}`
          : 'no matching catalogue record found';
        handReport.push(`- **${pubId}** — ${label}: ${hint}`);
      }
    }

    if (sources) {
      const unique = [...new Map(sources.map((s) => [s.url, s])).values()].slice(0, 4);
      if (!handPatches.has(file)) handPatches.set(file, []);
      handPatches.get(file).push({ index, sources: unique });
    }
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

// Free copies: sort Internet Archive scans into free and lending-only, and add HathiTrust
// full-view scans and Project Gutenberg ebooks.
console.log('Finding free copies…');
const publisherOf = new Map([...byPublisher].flatMap(([id, titles]) => titles.map((t) => [t, id])));
const free = await addFreeAccess([...byPublisher.values()].flat(), publisherOf);
console.log(
  `  Internet Archive ${free.iaFree} free, ${free.iaBorrow} lending only, ${free.iaGone} withdrawn; ` +
    `HathiTrust ${free.hathi}; Project Gutenberg ${free.gutenberg}; NDL ${free.ndl}; Gallica ${free.gallica}; ` +
    `${free.restricted} library scans not open; by author: Internet Archive ${free.iaByAuthor}, marxists.org ${free.marxists}; Mir Titles ${free.mirTitles} ` +
    `(${freeAccessRequests()} requests)`,
);

const summary = [];
for (const rule of PUBLISHERS) {
  // A hand-entered title stands for its edition; never write an imported copy of it as well.
  const hand = handTitlesByPublisher.get(rule.id) ?? [];
  const titles = [...byPublisher.get(rule.id)]
    // A record without a title cannot be identified.
    .filter((t) => t.title && t.title !== '[Untitled]')
    .filter((t) => !hand.some((h) => (t.year === h.year || !t.year) && titlesMatch(h, t) && authorsOverlap(h.authors, t.authors)))
    .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999) || a.title.localeCompare(b.title));
  // Last spelling, spacing and casing corrections, whichever source a record came from.
  for (const t of titles) {
    t.title = polishTitle(t.title, t.language);
    if (t.subtitle) t.subtitle = polishTitle(t.subtitle, t.language);
    for (const field of ['authors', 'editors']) {
      if (t[field]) t[field] = [...new Set(splitCredits(t[field]).map(polishCredit).filter(Boolean))];
    }
    if (t.series) t.series = seriesNumber({ ...t, series: normaliseSeries(t.series) });
    if (!t.series || /^(Little )?New World Paperbacks$/.test(t.series)) t.series = seriesFromLists(t, rule.id) ?? t.series;
    if (!t.series) delete t.series;
  }
  // Authors outside the scope of the collection (fascists, conservatives, liberals): see lib/not-left.mjs.
  titles.splice(0, titles.length, ...titles.map(screenTitle).filter(Boolean));
  const verified = titles.filter((t) => t.verified).length;
  summary.push(`| ${rule.id} | ${titles.length} | ${verified} |`);
  if (WRITE && titles.length) {
    const dir = join(CATALOGUES, rule.id);
    mkdirSync(dir, { recursive: true });
    const header =
      `# GENERATED by scripts/import-openlibrary.mjs from Open Library, cross-referenced with the\n` +
      `# Internet Archive and BannedThought.net — do not edit by hand.\n` +
      `# Corrections belong in Open Library or in a separate hand-written file in this folder.\n`;
    writeFileSync(join(dir, GENERATED), header + yaml.dump({ publisher: rule.id, titles }, { lineWidth: -1, noRefs: true }));
  } else if (WRITE) {
    // No imported titles left (all superseded by hand-entered ones, or none found): remove the
    // previous run's file rather than leave stale records behind.
    rmSync(join(CATALOGUES, rule.id, GENERATED), { force: true });
  }
}

let handVerified = 0;
for (const [file, patches] of handPatches) {
  handVerified += patches.length;
  if (WRITE) patchListFile(file, 'titles', patches);
}

const fmt = (ed) => `- ${clean(ed.title)} — ${(ed.publishers ?? []).join('/')}, ${(ed.publish_places ?? []).join('/') || ed.publish_country || '?'}, ${ed.publish_date ?? 'n.d.'} <${OL}${ed.key}>`;
mkdirSync(join(ROOT, 'reports'), { recursive: true });
writeFileSync(join(ROOT, 'reports', 'import-review.md'), [
  '# Open Library import — review report',
  '',
  `Generated ${new Date().toISOString().slice(0, 10)}. ${editions.size} candidate editions examined.`,
  '',
  '| Publisher | Titles imported | Verified |',
  '|---|---|---|',
  ...summary,
  '',
  `## Hand-entered titles not verified (${handReport.length})`,
  '',
  ...handReport,
  '',
  `## Editions with no place of publication (${review['no-place'].length})`,
  'Could not be assigned between the Moscow, Hanoi, Pyongyang and Beijing houses (or others) without a place.',
  '',
  ...review['no-place'].map(fmt),
  '',
  `## Imprint year outside the house's years of operation (${review['out-of-range'].length})`,
  '',
  ...review['out-of-range'].map(fmt),
  '',
  `## Matching imprint name, but a different city (${review['other-place'].length})`,
  '',
  ...review['other-place'].map(fmt),
  '',
].join('\n'));

console.log(`\n| Publisher | Titles | Verified |\n|---|---|---|\n${summary.join('\n')}`);
console.log(`\nHand-entered titles verified: ${handVerified}; not verified: ${handReport.length}`);
console.log(`Review: ${review['no-place'].length} without place, ${review['out-of-range'].length} out of range, ${review['other-place'].length} other place`);
console.log(`${requestCount()} network requests. ${WRITE ? 'Files written.' : 'Dry run — pass --write to update data files.'}`);
console.log(`Report: ${relative(ROOT, join(ROOT, 'reports', 'import-review.md'))}`);
