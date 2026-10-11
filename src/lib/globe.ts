/**
 * Countries on the globe page: each publisher country's Cold War alignment, the map areas it
 * covers and where its pin goes.
 *
 * - communist: states ruled by a communist party today
 * - formercommunist: former communist states
 * - nonaligned: members of the Non-Aligned Movement, most of them former colonies, including those that became
 *   allies of the United States only after the Soviet Union's fall in 1991
 * - usaligned: members of the Non-Aligned Movement that were aligned with the United States
 *   during the Cold War and joined the movement only after it (the Philippines and Thailand in 1993,
 *   South Africa in 1994, Haiti in 2006)
 * - neutral: states neutral in the Cold War (Switzerland, Austria, Sweden, Finland, Ireland)
 * - western: states aligned with the West
 *
 * Countries with no publishers in the catalogue are shown in gray. Area names are those of the
 * Natural Earth world atlas, plus "West Germany" and "East Germany" (src/data/divided-germany.json)
 * and the states of the UN Partition Plan of 1947 (src/data/partition-1947.json).
 */
export type Bloc = 'communist' | 'formercommunist' | 'nonaligned' | 'usaligned' | 'neutral' | 'western';

export interface GlobeCountry {
  bloc: Bloc;
  /** Map areas shaded for this country; historical states cover their successors. */
  areas: string[];
  /** Pin position [longitude, latitude], at the capital (for Germany, West Germany's Bonn, as East Berlin is East Germany's pin). */
  pin: [number, number];
  note?: string;
}

const SOVIET_REPUBLICS = [
  'Russia', 'Ukraine', 'Belarus', 'Moldova', 'Estonia', 'Latvia', 'Lithuania', 'Georgia', 'Armenia',
  'Azerbaijan', 'Kazakhstan', 'Uzbekistan', 'Turkmenistan', 'Kyrgyzstan', 'Tajikistan',
];

export const COUNTRIES: Record<string, GlobeCountry> = {
  // Communist states
  China: { bloc: 'communist', areas: ['China'], pin: [116.4, 39.9], note: "The People's Republic since 1949; allied with the Soviet Union until the Sino-Soviet split of 1960, then a rival centre of the communist movement." },
  'North Korea': { bloc: 'communist', areas: ['North Korea'], pin: [125.75, 39.04], note: "The Democratic People's Republic of Korea since 1948, allied with both the Soviet Union and China; a member of the Non-Aligned Movement since 1975." },
  Vietnam: { bloc: 'communist', areas: ['Vietnam'], pin: [105.85, 21.03], note: "The Democratic Republic of Vietnam in the north from 1945, reunified as the Socialist Republic in 1976; allied with the Soviet Union." },
  Laos: { bloc: 'communist', areas: ['Laos'], pin: [102.63, 17.97], note: "The Lao People's Democratic Republic since 1975, closely allied with Vietnam and the Soviet Union." },
  Thailand: { bloc: 'usaligned', areas: ['Thailand'], pin: [100.5, 13.75], note: "A member of SEATO (1954–1977) and a US ally in the Vietnam War, against whose government the Communist Party of Thailand waged an armed struggle from 1965 to the early 1980s, its front publishing from Peking. a member of the Non-Aligned Movement since 1993, and a US Major Non-NATO Ally since 2003." },
  Cuba: { bloc: 'communist', areas: ['Cuba'], pin: [-82.37, 23.11], note: "A socialist state since the revolution of 1959, allied with the Soviet Union from 1961 and a founding member of the Non-Aligned Movement (1961)." },

  // Former communist states
  'Soviet Union': { bloc: 'formercommunist', areas: SOVIET_REPUBLICS, pin: [37.62, 55.76], note: "The Union of Soviet Socialist Republics, 1922–1991, leader of the Eastern bloc and the Warsaw Pact. Shown across its fifteen successor states." },
  'East Germany': { bloc: 'formercommunist', areas: ['East Germany'], pin: [13.45, 52.52], note: "The German Democratic Republic, 1949–1990, a member of the Warsaw Pact; shown within the inner German border." },
  Albania: { bloc: 'formercommunist', areas: ['Albania'], pin: [19.82, 41.33], note: "The People's Socialist Republic, 1946–1991; it broke with the Soviet Union in 1961, left the Warsaw Pact in 1968 and broke with China in 1978." },
  Bulgaria: { bloc: 'formercommunist', areas: ['Bulgaria'], pin: [23.32, 42.7], note: "The People's Republic of Bulgaria, 1946–1990, the Soviet Union's closest ally in the Warsaw Pact." },
  Romania: { bloc: 'formercommunist', areas: ['Romania'], pin: [26.1, 44.43], note: "The Socialist Republic of Romania, 1947–1989, a member of the Warsaw Pact that followed an independent foreign policy under Ceaușescu." },
  Ethiopia: { bloc: 'formercommunist', areas: ['Ethiopia'], pin: [38.75, 9.03], note: "Ruled by the Marxist–Leninist Derg from 1974 and a People's Democratic Republic from 1987 to 1991, allied with the Soviet Union; a founding member of the Non-Aligned Movement (1961)." },
  Mozambique: { bloc: 'formercommunist', areas: ['Mozambique'], pin: [32.57, -25.97], note: "A People's Republic under FRELIMO, 1975–1990, allied with the Soviet Union; a member of the Non-Aligned Movement." },

  // Former colonies in the Non-Aligned Movement
  India: { bloc: 'nonaligned', areas: ['India'], pin: [77.21, 28.61], note: "A founding member of the Non-Aligned Movement (1961) under Nehru, bound to the Soviet Union by the Treaty of Friendship of 1971." },

  'Sri Lanka': { bloc: 'nonaligned', areas: ['Sri Lanka'], pin: [79.92, 6.89], note: "Ceylon until 1972; a founding member of the Non-Aligned Movement (1961)." },
  Indonesia: { bloc: 'nonaligned', areas: ['Indonesia'], pin: [106.85, -6.21], note: "Host of the Bandung Conference of 1955 and a founding member of the Non-Aligned Movement (1961); after the destruction of the Communist Party in 1965–1966, Suharto's New Order leaned to the West." },
  Lebanon: { bloc: 'nonaligned', areas: ['Lebanon'], pin: [35.5, 33.89], note: "A founding member of the Non-Aligned Movement (1961)." },
  Tanzania: { bloc: 'nonaligned', areas: ['Tanzania'], pin: [35.74, -6.17], note: "A member of the Non-Aligned Movement, whose capital Dar es Salaam hosted the southern African liberation movements under Nyerere's socialism." },
  'South Africa': { bloc: 'usaligned', areas: ['South Africa'], pin: [28.19, -25.75], note: "Under apartheid until 1994 an anticommunist state aligned with the West, which banned the Communist Party in 1950; a member of the Non-Aligned Movement since 1994." },
  Nicaragua: { bloc: 'nonaligned', areas: ['Nicaragua'], pin: [-86.25, 12.13], note: "Ruled by the US-backed Somoza dynasty until the Sandinista revolution of 1979, after which it joined the Non-Aligned Movement and fought the US-backed Contras." },
  Chile: { bloc: 'western', areas: ['Chile'], pin: [-70.67, -33.45], note: "A member of the Non-Aligned Movement under Salvador Allende (1971–1973); after the US-backed coup of 1973, aligned with the United States under Pinochet's dictatorship until 1990. No longer a member." },

  // Non-Aligned members that became allies of the United States
  Argentina: { bloc: 'nonaligned', areas: ['Argentina'], pin: [-58.38, -34.6], note: "A member of the Non-Aligned Movement from 1973 to 1991, even under the military junta of 1976–1983; a US Major Non-NATO Ally since 1998 and now an observer." },
  Philippines: { bloc: 'usaligned', areas: ['Philippines'], pin: [120.98, 14.6], note: "A US treaty ally (1951) and a member of SEATO (1954–1977), ruled by Marcos from 1965 to 1986; a member of the Non-Aligned Movement since 1993 and a US Major Non-NATO Ally since 2003." },
  Pakistan: { bloc: 'nonaligned', areas: ['Pakistan'], pin: [73.05, 33.68], note: "A member of the US-led SEATO and CENTO pacts in the 1950s, which it left in the 1970s; a member of the Non-Aligned Movement from 1979, and a US Major Non-NATO Ally since 2004." },

  // Western-aligned states
  'United States': { bloc: 'western', areas: ['United States of America'], pin: [-77.04, 38.91], note: "Leader of the Western bloc: a founding member of NATO (1949), the Rio Pact (1947), ANZUS (1951) and SEATO (1954)." },
  Canada: { bloc: 'western', areas: ['Canada'], pin: [-75.7, 45.42], note: "A founding member of NATO (1949), and joined with the United States in continental air defence by NORAD (1958)." },
  Mexico: { bloc: 'western', areas: ['Mexico'], pin: [-99.13, 19.43], note: "Never part of a Cold War alliance and officially non-interventionist — it kept relations with revolutionary Cuba — but within the US sphere under the long rule of the PRI. An observer, not a member, of the Non-Aligned Movement." },
  Brazil: { bloc: 'western', areas: ['Brazil'], pin: [-47.88, -15.79], note: "A signatory of the Rio Pact (1947), firmly aligned with the United States under the military dictatorship of 1964–1985, which took power in a coup backed by Washington. An observer, not a member, of the Non-Aligned Movement." },
  Uruguay: { bloc: 'western', areas: ['Uruguay'], pin: [-56.16, -34.9], note: "A signatory of the Rio Pact (1947), aligned with the United States, above all under the civic-military dictatorship of 1973–1985. An observer, not a member, of the Non-Aligned Movement." },
  'United Kingdom': { bloc: 'western', areas: ['United Kingdom', 'Falkland Is.'], pin: [-0.13, 51.51], note: "A founding member of NATO (1949). The closest ally of the United States. Shown with the Falkland Islands." },
  Ireland: { bloc: 'neutral', areas: ['Ireland'], pin: [-6.26, 53.35], note: "Neutral; it never joined NATO." },
  France: { bloc: 'western', areas: ['France'], pin: [2.35, 48.86], note: "A founding member of NATO (1949). Under de Gaulle it left NATO's integrated military command from 1966 to 2009, while remaining in the alliance." },
  Belgium: { bloc: 'western', areas: ['Belgium'], pin: [4.35, 50.85], note: "A founding member of NATO (1949)." },
  Netherlands: { bloc: 'western', areas: ['Netherlands'], pin: [4.9, 52.37], note: "A founding member of NATO (1949)." },
  Germany: { bloc: 'western', areas: ['West Germany'], pin: [7.1, 50.73], note: "West Germany, a member of NATO from 1955. The Federal Republic within its 1949–1990 borders, with West Berlin. Presses from before 1949 are listed here too." },
  Switzerland: { bloc: 'neutral', areas: ['Switzerland'], pin: [7.45, 46.95], note: "Neutral since 1815; it joined neither bloc." },
  Austria: { bloc: 'neutral', areas: ['Austria'], pin: [16.37, 48.21], note: "Neutral from 1955 by its State Treaty and constitution, when the Soviet and Western occupying powers withdrew." },
  Italy: { bloc: 'western', areas: ['Italy'], pin: [12.5, 41.9], note: "A founding member of NATO (1949). Home of the largest communist party in the West." },
  Spain: { bloc: 'western', areas: ['Spain'], pin: [-3.7, 40.42], note: "Allied with the United States under Franco by the Pact of Madrid (1953), which brought American bases; it joined NATO in 1982, after the transition to democracy." },
  Portugal: { bloc: 'western', areas: ['Portugal'], pin: [-9.14, 38.72], note: "A founding member of NATO (1949). Joined under the Salazar dictatorship, which lasted until the Carnation Revolution of 1974." },
  Greece: { bloc: 'western', areas: ['Greece'], pin: [23.73, 37.98], note: "A member of NATO from 1952, after the civil war of 1946–1949 in which the communists were defeated with British and American aid; ruled by a US-backed military junta from 1967 to 1974." },
  Turkey: { bloc: 'western', areas: ['Turkey'], pin: [32.86, 39.93], note: "A member of NATO from 1952 and of the Baghdad Pact (CENTO) from 1955, with American bases and missiles on its soil." },
  Norway: { bloc: 'western', areas: ['Norway'], pin: [10.75, 59.91], note: "A founding member of NATO (1949)." },
  Sweden: { bloc: 'neutral', areas: ['Sweden'], pin: [18.07, 59.33], note: "Neutral and outside NATO, though secretly cooperating with the West; it joined NATO only in 2024." },
  Finland: { bloc: 'neutral', areas: ['Finland'], pin: [24.94, 60.17], note: "Neutral but bound to the Soviet Union by the Treaty of Friendship of 1948; it joined NATO only in 2023." },
  Japan: { bloc: 'western', areas: ['Japan'], pin: [139.69, 35.69], note: "Allied with the United States by the Security Treaty of 1951, revised in 1960, under which American forces are based in Japan." },
  Australia: { bloc: 'western', areas: ['Australia'], pin: [149.13, -35.28], note: "Allied with the United States by the ANZUS Treaty (1951) and a member of SEATO (1954–1977); it fought beside the United States in Korea and Vietnam." },
  'New Zealand': { bloc: 'western', areas: ['New Zealand'], pin: [174.78, -41.29], note: "Allied with the United States by the ANZUS Treaty (1951) and a member of SEATO (1954–1977), until its nuclear-free policy led the United States to suspend its treaty obligations in 1986." },

  // Added with the second round of publishers
  Poland: { bloc: 'formercommunist', areas: ['Poland'], pin: [21.01, 52.23], note: "The Polish People's Republic, 1947–1989, a member of the Warsaw Pact." },
  Czechoslovakia: { bloc: 'formercommunist', areas: ['Czechia', 'Slovakia'], pin: [14.42, 50.09], note: "The Czechoslovak Socialist Republic, 1948–1989, a member of the Warsaw Pact, invaded by it in 1968. Shown across the Czech Republic and Slovakia." },
  Yugoslavia: { bloc: 'formercommunist', areas: ['Serbia', 'Croatia', 'Slovenia', 'Bosnia and Herz.', 'Montenegro', 'Macedonia', 'Kosovo'], pin: [20.46, 44.82], note: "The Socialist Federal Republic, 1945–1992, which broke with Stalin in 1948 and was a founding member of the Non-Aligned Movement (1961). Shown across its successor states." },
  Mongolia: { bloc: 'formercommunist', areas: ['Mongolia'], pin: [106.92, 47.92], note: "The Mongolian People's Republic, 1924–1992, the Soviet Union's oldest ally." },
  'South Yemen': { bloc: 'formercommunist', areas: ['Yemen'], pin: [45.03, 12.79], note: "The People's Democratic Republic of Yemen, 1967–1990, the only Marxist state in the Arab world, allied with the Soviet Union; shown on the map of unified Yemen." },
  Angola: { bloc: 'formercommunist', areas: ['Angola'], pin: [13.23, -8.84], note: "A People's Republic under the MPLA, 1975–1992, allied with the Soviet Union and Cuba; a member of the Non-Aligned Movement." },
  Madagascar: { bloc: 'formercommunist', areas: ['Madagascar'], pin: [47.52, -18.88], note: "The socialist Democratic Republic of Madagascar, 1975–1992; a member of the Non-Aligned Movement." },
  Cambodia: { bloc: 'formercommunist', areas: ['Cambodia'], pin: [104.92, 11.56], note: "Democratic Kampuchea, 1975–1979, and the Khmer Rouge-led government in exile; Cambodia was a founding member of the Non-Aligned Movement (1961)." },
  Egypt: { bloc: 'nonaligned', areas: ['Egypt'], pin: [31.24, 30.04], note: "A founding member of the Non-Aligned Movement (1961), aligned with the Soviet Union under Nasser and with the United States after the Camp David Accords (1978); a US Major Non-NATO Ally since 1989." },
  Colombia: { bloc: 'nonaligned', areas: ['Colombia'], pin: [-74.07, 4.71], note: "A signatory of the Rio Pact (1947) that sent troops to Korea; a member of the Non-Aligned Movement since 1983, and a US Major Non-NATO Ally since 2022." },
  Eritrea: { bloc: 'nonaligned', areas: ['Eritrea'], pin: [38.93, 15.32], note: "Independent from Ethiopia in 1993 after a thirty-year war of liberation; a member of the Non-Aligned Movement." },
  'Guinea-Bissau': { bloc: 'nonaligned', areas: ['Guinea-Bissau'], pin: [-15.6, 11.86], note: "Independent from Portugal in 1974 after the PAIGC's war of liberation; a member of the Non-Aligned Movement. Shown with Cape Verde, which is too small to show on this map." },
  Peru: { bloc: 'nonaligned', areas: ['Peru'], pin: [-77.04, -12.05], note: "A member of the Non-Aligned Movement since 1973, which it joined under the left-wing military government of Juan Velasco Alvarado." },
  Bolivia: { bloc: 'nonaligned', areas: ['Bolivia'], pin: [-68.15, -16.5], note: "A member of the Non-Aligned Movement since 1979, after years of US-backed military rule." },
  Ecuador: { bloc: 'nonaligned', areas: ['Ecuador'], pin: [-78.47, -0.18], note: "A member of the Non-Aligned Movement since 1983." },
  Myanmar: { bloc: 'nonaligned', areas: ['Myanmar'], pin: [96.13, 19.75], note: "Burma; a founding member of the Non-Aligned Movement (1961), which kept strictly neutral under the socialist one-party rule of Ne Win (1962–1988)." },
  Nepal: { bloc: 'nonaligned', areas: ['Nepal'], pin: [85.32, 27.72], note: "A founding member of the Non-Aligned Movement (1961), though never a colony." },
  Denmark: { bloc: 'western', areas: ['Denmark', 'Greenland'], pin: [12.57, 55.68], note: "A founding member of NATO (1949). Shown with Greenland, part of the Danish realm." },
  Haiti: { bloc: 'usaligned', areas: ['Haiti'], pin: [-72.34, 18.54], note: "Under the US-backed Duvalier dictatorship from 1957 to 1986; a member of the Non-Aligned Movement since 2006." },

  // Added with the third round of publishers
  Guyana: { bloc: 'nonaligned', areas: ['Guyana'], pin: [-58.16, 6.8], note: "A member of the Non-Aligned Movement since 1970, whose governments under Forbes Burnham declared it a \"cooperative socialist republic\"." },
  Grenada: { bloc: 'nonaligned', areas: [], pin: [-61.75, 12.06], note: "The People's Revolutionary Government of the New Jewel Movement, 1979–1983, ended by the US invasion; a member of the Non-Aligned Movement. Too small to shade on this map." },
  Jamaica: { bloc: 'nonaligned', areas: ['Jamaica'], pin: [-76.79, 17.97], note: "A member of the Non-Aligned Movement, whose government under Michael Manley (1972–1980) pursued democratic socialism and ties with Cuba." },
  Afghanistan: { bloc: 'formercommunist', areas: ['Afghanistan'], pin: [69.17, 34.53], note: "The Democratic Republic of Afghanistan, 1978–1992, backed by Soviet troops from 1979 to 1989; Afghanistan was a founding member of the Non-Aligned Movement (1961)." },
  Cyprus: { bloc: 'nonaligned', areas: ['Cyprus', 'N. Cyprus'], pin: [33.38, 35.17], note: "A founding member of the Non-Aligned Movement (1961) under Archbishop Makarios, which it left on joining the European Union in 2004." },
  Iceland: { bloc: 'western', areas: ['Iceland'], pin: [-21.94, 64.15], note: "A founding member of NATO (1949). With an American air base at Keflavík from 1951 to 2006." },
  'Réunion': { bloc: 'western', areas: [], pin: [55.45, -20.88], note: "An overseas department of France, a member of NATO; too small to shade on this map." },
  Guadeloupe: { bloc: 'western', areas: [], pin: [-61.73, 16.0], note: "An overseas department of France, a member of NATO; too small to shade on this map." },
  Martinique: { bloc: 'western', areas: [], pin: [-61.07, 14.6], note: "An overseas department of France, a member of NATO; too small to shade on this map." },

  // Palestine, and the Soviet-recognised Israeli communists
  Palestine: { bloc: 'nonaligned', areas: ['Arab State (1947 plan)'], pin: [35.2, 31.9], note: "Shown as the Arab State of the UN Partition Plan of 1947. A former British mandate; the PLO has been a full member of the Non-Aligned Movement since 1976." },
  Israel: { bloc: 'western', areas: ['Jewish State (1947 plan)'], pin: [34.78, 32.08], note: "Aligned with the United States from the 1960s, and a Major Non-NATO Ally since 1987. Shown as the Jewish State of the UN Partition Plan of 1947. Only Rakah, the communist faction recognised by the Soviet Union after 1965, is catalogued." },
  Morocco: { bloc: 'nonaligned', areas: ['Morocco'], pin: [-6.85, 34.02], note: "A founding member of the Non-Aligned Movement (1961), though close to the United States under Hassan II; a US Major Non-NATO Ally since 2004." },
  Oman: { bloc: 'nonaligned', areas: ['Oman'], pin: [58.41, 23.59], note: "Allied with Britain and Iran against the Dhofar revolution of 1965–1976; a member of the Non-Aligned Movement. Pinned in Dhofar, the province of the PFLO's revolution." },

  // Added with the fifth round of publishers
  Iran: { bloc: 'nonaligned', areas: ['Iran'], pin: [51.39, 35.69], note: "Never a colony; aligned with the United States under the Shah, a member of CENTO, until the revolution of 1979, since when it has been a member of the Non-Aligned Movement." },
  Bangladesh: { bloc: 'nonaligned', areas: ['Bangladesh'], pin: [90.41, 23.81], note: "Independent from Pakistan in 1971; a member of the Non-Aligned Movement since 1973." },
  Paraguay: { bloc: 'western', areas: ['Paraguay'], pin: [-57.58, -25.26], note: "A signatory of the Rio Pact (1947), aligned with the United States under the anticommunist dictatorship of Alfredo Stroessner (1954–1989). An observer, not a member, of the Non-Aligned Movement." },
  Venezuela: { bloc: 'nonaligned', areas: ['Venezuela'], pin: [-66.9, 10.48], note: "A member of the Non-Aligned Movement since 1989, after decades of alignment with the United States." },
  Panama: { bloc: 'nonaligned', areas: ['Panama'], pin: [-79.52, 8.98], note: "Under US influence through the Canal Zone, returned by the Torrijos–Carter Treaties of 1977; a member of the Non-Aligned Movement since 1975." },
  'Costa Rica': { bloc: 'western', areas: ['Costa Rica'], pin: [-84.09, 9.93], note: "A signatory of the Rio Pact (1947), aligned with the United States, though it abolished its army in 1948 and declared itself neutral in 1983. An observer, not a member, of the Non-Aligned Movement." },
  Honduras: { bloc: 'usaligned', areas: ['Honduras'], pin: [-87.21, 14.07], note: "A base for the US-backed Contras in the 1980s; a member of the Non-Aligned Movement since 1995." },
  'El Salvador': { bloc: 'western', areas: ['El Salvador'], pin: [-89.19, 13.69], note: "Ruled by US-backed military governments, and during the civil war of 1979–1992 one of the largest recipients of American military aid, against the FMLN. An observer, not a member, of the Non-Aligned Movement." },
  Guatemala: { bloc: 'usaligned', areas: ['Guatemala'], pin: [-90.51, 14.63], note: "Under US-backed military governments after the CIA-organised coup of 1954, through the civil war of 1960–1996; a member of the Non-Aligned Movement since 1993." },
  'Dominican Republic': { bloc: 'usaligned', areas: ['Dominican Rep.'], pin: [-69.93, 18.49], note: "Under the dictatorship of Trujillo until 1961 and occupied by the United States in 1965; a member of the Non-Aligned Movement since 2000." },
  Cameroon: { bloc: 'nonaligned', areas: ['Cameroon'], pin: [11.52, 3.85], note: "Independent from France in 1960 after the war against the UPC; a member of the Non-Aligned Movement, aligned with France." },
  Zimbabwe: { bloc: 'nonaligned', areas: ['Zimbabwe'], pin: [31.05, -17.83], note: "Rhodesia, under white-minority rule, until 1980; a member of the Non-Aligned Movement since independence." },
  'Western Sahara': { bloc: 'nonaligned', areas: ['W. Sahara'], pin: [-13.2, 27.15], note: "A former Spanish colony, claimed by the Sahrawi Arab Democratic Republic and largely occupied by Morocco." },
  Liberia: { bloc: 'nonaligned', areas: ['Liberia'], pin: [-10.8, 6.3], note: "Never a colony; a member of the Non-Aligned Movement, and a close US ally during the Cold War." },
  Senegal: { bloc: 'nonaligned', areas: ['Senegal'], pin: [-17.44, 14.69], note: "Independent from France in 1960; a member of the Non-Aligned Movement, aligned with France." },
  Kenya: { bloc: 'nonaligned', areas: ['Kenya'], pin: [36.82, -1.29], note: "Independent from Britain in 1963; a member of the Non-Aligned Movement, close to the West, and a US Major Non-NATO Ally since 2024." },
  Hungary: { bloc: 'formercommunist', areas: ['Hungary'], pin: [19.04, 47.5], note: "The Hungarian People's Republic, 1949–1989, a member of the Warsaw Pact; the revolution of 1956 was crushed by Soviet forces." },
  Luxembourg: { bloc: 'western', areas: ['Luxembourg'], pin: [6.13, 49.61], note: "A founding member of NATO (1949)." },

  // Added with the sixth round of publishers
  Namibia: { bloc: 'nonaligned', areas: ['Namibia'], pin: [17.08, -22.56], note: "Under South African rule until 1990; SWAPO represented it in the Non-Aligned Movement before independence." },
  'São Tomé and Príncipe': { bloc: 'formercommunist', areas: [], pin: [6.73, 0.34], note: "A Marxist one-party state under the MLSTP, 1975–1990. Too small to shade on this map." },
  Seychelles: { bloc: 'nonaligned', areas: [], pin: [55.45, -4.62], note: "A socialist one-party state, 1978–1993; a member of the Non-Aligned Movement. Too small to shade on this map." },
  Mauritius: { bloc: 'nonaligned', areas: [], pin: [57.5, -20.16], note: "A member of the Non-Aligned Movement. Too small to shade on this map." },
  Somalia: { bloc: 'formercommunist', areas: ['Somalia', 'Somaliland'], pin: [45.34, 2.05], note: "The Somali Democratic Republic, 1969–1991, a Soviet ally until the Ogaden War of 1977, then aligned with the United States; a founding member of the Non-Aligned Movement (1961). Shown with Somaliland." },
  'South Korea': { bloc: 'western', areas: ['South Korea'], pin: [126.98, 37.57], note: "Allied with the United States by the Mutual Defense Treaty of 1953, with American forces stationed there since the Korean War; ruled by anticommunist dictatorships until 1987." },
  'Timor-Leste': { bloc: 'nonaligned', areas: ['Timor-Leste'], pin: [125.57, -8.56], note: "Occupied by Indonesia, 1975–1999, after FRETILIN declared independence from Portugal; a member of the Non-Aligned Movement." },
  'Trinidad and Tobago': { bloc: 'nonaligned', areas: ['Trinidad and Tobago'], pin: [-61.46, 10.27], note: "A member of the Non-Aligned Movement since 1970." },
  'Saint Vincent and the Grenadines': { bloc: 'nonaligned', areas: [], pin: [-61.22, 13.16], note: "A member of the Non-Aligned Movement. Too small to shade on this map." },
  Bahamas: { bloc: 'nonaligned', areas: ['Bahamas'], pin: [-77.35, 25.06], note: "Independent from 1973; a member of the Non-Aligned Movement from 1983." },
  Algeria: { bloc: 'nonaligned', areas: ['Algeria'], pin: [3.06, 36.75], note: "Under French rule until 1962; its provisional government was a founding member of the Non-Aligned Movement (1961), and independent Algeria a leading voice of the movement." },
  Tunisia: { bloc: 'nonaligned', areas: ['Tunisia'], pin: [10.18, 36.8], note: "A founding member of the Non-Aligned Movement (1961), close to the West under Bourguiba; a US Major Non-NATO Ally since 2015." },
  Mali: { bloc: 'nonaligned', areas: ['Mali'], pin: [-8.0, 12.64], note: "A socialist one-party state under Modibo Keïta, 1960–1968; a founding member of the Non-Aligned Movement (1961)." },
  Nigeria: { bloc: 'nonaligned', areas: ['Nigeria'], pin: [7.49, 9.06], note: "Independent from Britain in 1960; a member of the Non-Aligned Movement." },
  Jordan: { bloc: 'nonaligned', areas: ['Jordan'], pin: [35.93, 31.95], note: "A member of the Non-Aligned Movement, close to Britain and the United States under King Hussein; a US Major Non-NATO Ally since 1996." },
  Gambia: { bloc: 'nonaligned', areas: ['Gambia'], pin: [-16.58, 13.45], note: "Independent from Britain in 1965; a member of the Non-Aligned Movement." },
  'Democratic Republic of the Congo': { bloc: 'nonaligned', areas: ['Dem. Rep. Congo'], pin: [15.31, -4.32], note: "The Congo, a founding member of the Non-Aligned Movement (1961) under Lumumba's successors; under the US-backed Mobutu from 1965, as Zaire from 1971 to 1997." },
  Suriname: { bloc: 'nonaligned', areas: ['Suriname'], pin: [-55.2, 5.85], note: "A Dutch colony until 1975; a member of the Non-Aligned Movement, which under the military government of 1980–1987 briefly turned to Cuba." },
  Botswana: { bloc: 'nonaligned', areas: ['Botswana'], pin: [25.91, -24.65], note: "Independent from Britain in 1966; a member of the Non-Aligned Movement, bordering apartheid South Africa." },
  Togo: { bloc: 'nonaligned', areas: ['Togo'], pin: [1.23, 6.13], note: "Independent from France in 1960; a member of the Non-Aligned Movement, aligned with France under Eyadéma (1967–2005)." },
  "Côte d'Ivoire": { bloc: 'nonaligned', areas: ["Côte d'Ivoire"], pin: [-5.28, 6.82], note: "Independent from France in 1960; a member of the Non-Aligned Movement, closely aligned with France under Houphouët-Boigny." },
  eSwatini: { bloc: 'nonaligned', areas: ['eSwatini'], pin: [31.14, -26.31], note: "Swaziland, independent from Britain in 1968; a member of the Non-Aligned Movement, an absolute monarchy where political parties are banned." },
  Lesotho: { bloc: 'nonaligned', areas: ['Lesotho'], pin: [27.48, -29.31], note: "Basutoland, independent from Britain in 1966; a member of the Non-Aligned Movement, an enclave within South Africa." },
  Uganda: { bloc: 'nonaligned', areas: ['Uganda'], pin: [32.58, 0.35], note: "Independent from Britain in 1962; a member of the Non-Aligned Movement. Under Obote's \"Move to the Left\" (1969–1971), then the dictatorship of Idi Amin (1971–1979)." },
  Niger: { bloc: 'nonaligned', areas: ['Niger'], pin: [2.11, 13.51], note: "Independent from France in 1960; a member of the Non-Aligned Movement, closely aligned with France under Hamani Diori, who suppressed the Sawaba movement." },
  Djibouti: { bloc: 'nonaligned', areas: ['Djibouti'], pin: [43.15, 11.59], note: "The French Territory of the Afars and the Issas until independence in 1977; a member of the Non-Aligned Movement, with a French military base." },
  Malawi: { bloc: 'nonaligned', areas: ['Malawi'], pin: [33.79, -13.96], note: "Independent from Britain in 1964; a member of the Non-Aligned Movement, though under Hastings Banda (1964–1994) an anticommunist dictatorship and the only African state with full relations with apartheid South Africa." },
  'Sierra Leone': { bloc: 'nonaligned', areas: ['Sierra Leone'], pin: [-13.23, 8.48], note: "Independent from Britain in 1961; a member of the Non-Aligned Movement." },
  Barbados: { bloc: 'nonaligned', areas: [], pin: [-59.6, 13.1], note: "A member of the Non-Aligned Movement. Too small to shade on this map." },
  'Antigua and Barbuda': { bloc: 'usaligned', areas: [], pin: [-61.85, 17.12], note: "Independent from Britain in 1981 and aligned with the West in the Cold War; a member of the Non-Aligned Movement since 2006. Too small to shade on this map." },
  Malaysia: { bloc: 'nonaligned', areas: ['Malaysia'], pin: [101.69, 3.14], note: "A member of the Non-Aligned Movement since 1970, after the British war against the Malayan communist insurgency (1948–1960)." },

  // Added with the fourth round of publishers
  Iraq: { bloc: 'nonaligned', areas: ['Iraq'], pin: [44.36, 33.31], note: "A founding member of the Non-Aligned Movement (1961), which left the Baghdad Pact after the revolution of 1958 and signed a treaty of friendship with the Soviet Union in 1972." },
  Syria: { bloc: 'nonaligned', areas: ['Syria'], pin: [36.29, 33.51], note: "A member of the Non-Aligned Movement, allied with the Soviet Union from the 1970s." },
  Sudan: { bloc: 'nonaligned', areas: ['Sudan', 'S. Sudan'], pin: [32.53, 15.5], note: "A founding member of the Non-Aligned Movement (1961). Shown with South Sudan, independent since 2011." },
  Guinea: { bloc: 'nonaligned', areas: ['Guinea'], pin: [-13.68, 9.51], note: "Sékou Touré declared his state socialist and Marxist, but it was never a Soviet-model communist state; a founding member of the Non-Aligned Movement (1961)." },
  Ghana: { bloc: 'nonaligned', areas: ['Ghana'], pin: [-0.19, 5.6], note: "A founding member of the Non-Aligned Movement (1961) under Kwame Nkrumah, who was overthrown in 1966." },
  'Burkina Faso': { bloc: 'nonaligned', areas: ['Burkina Faso'], pin: [-1.52, 12.37], note: "Upper Volta until Thomas Sankara's revolution of 1983–1987; a member of the Non-Aligned Movement." },
  Congo: { bloc: 'formercommunist', areas: ['Congo'], pin: [15.24, -4.27], note: "The People's Republic of the Congo, 1969–1991, a Marxist–Leninist state; a member of the Non-Aligned Movement." },
  Benin: { bloc: 'formercommunist', areas: ['Benin'], pin: [2.63, 6.5], note: "The People's Republic of Benin, 1975–1990, a Marxist–Leninist state; a member of the Non-Aligned Movement." },
};

export const BLOC_LABELS: Record<Bloc, string> = {
  communist: 'Communist state',
  formercommunist: 'Former communist state',
  nonaligned: 'Non-Aligned Movement member',
  usaligned: 'Non-Aligned member allied with the United States in the Cold War',
  neutral: 'Neutral in the Cold War',
  western: 'Western-aligned',
};

/**
 * Islands with their own pin that are filed under a country: a publisher or movement with
 * `region` set is pinned here, and listed as "<region> (<country>)". The region's map area is
 * shaded with its country's alignment unless it has its own `bloc`, and opens the country when the
 * region has nothing listed.
 */
export interface GlobeRegion {
  country: string;
  areas: string[];
  pin: [number, number];
  bloc?: Bloc;
  /** Shown in the region's panel, e.g. its own Cold War alignment. */
  note?: string;
  /**
   * Listed under its own name ("Estonia") rather than "<region> (<country>)": the Soviet
   * republics, whose houses from before 1917 and after 1991 (filed under the republic as a
   * country) share the pin with those of the Soviet years.
   */
  standalone?: boolean;
}

/** A region's name on the globe. */
export const regionLabel = (region: string, r: GlobeRegion) => (r.standalone ? region : `${region} (${r.country})`);

// The Soviet republics other than Russia, pinned at their Soviet-era capitals; Russia and the
// all-Union houses stay on the Soviet Union's pin in Moscow.
const SOVIET_REPUBLIC_CAPITALS: Record<string, [number, number]> = {
  Ukraine: [30.52, 50.45], Belarus: [27.56, 53.9], Moldova: [28.86, 47.01], Estonia: [24.75, 59.44], Latvia: [24.11, 56.95],
  Lithuania: [25.28, 54.69], Georgia: [44.79, 41.72], Armenia: [44.51, 40.18], Azerbaijan: [49.87, 40.41], Kazakhstan: [76.89, 43.24],
  Uzbekistan: [69.24, 41.3], Turkmenistan: [58.38, 37.95], Kyrgyzstan: [74.59, 42.87], Tajikistan: [68.79, 38.56],
};

// The Yugoslav republics other than Serbia, pinned at their capitals, and its two autonomous
// provinces; Serbia and the federal houses stay on Yugoslavia's pin in Belgrade.
const YUGOSLAV_REPUBLICS: Record<string, { areas: string[]; pin: [number, number]; standalone?: boolean; note: string }> = {
  Slovenia: { areas: ['Slovenia'], pin: [14.51, 46.06], standalone: true, note: 'The Socialist Republic of Slovenia, a republic of the Yugoslav federation until its independence in 1991.' },
  Croatia: { areas: ['Croatia'], pin: [15.98, 45.81], standalone: true, note: 'The Socialist Republic of Croatia, a republic of the Yugoslav federation until its independence in 1991.' },
  'Bosnia and Herzegovina': { areas: ['Bosnia and Herz.'], pin: [18.41, 43.86], standalone: true, note: 'The Socialist Republic of Bosnia and Herzegovina, a republic of the Yugoslav federation until its independence in 1992.' },
  Montenegro: { areas: ['Montenegro'], pin: [19.26, 42.44], standalone: true, note: 'The Socialist Republic of Montenegro, a republic of the Yugoslav federation, whose capital was Titograd (Podgorica) from 1946 to 1992.' },
  Macedonia: { areas: ['Macedonia'], pin: [21.43, 42.0], standalone: true, note: 'The Socialist Republic of Macedonia, a republic of the Yugoslav federation until its independence in 1991.' },
  Kosovo: { areas: ['Kosovo'], pin: [21.17, 42.67], note: 'An autonomous province of Serbia within Yugoslavia, with Albanian-language publishing in Priština.' },
  Vojvodina: { areas: [], pin: [19.83, 45.27], note: 'An autonomous province of Serbia within Yugoslavia, centred on Novi Sad, with publishing in its minorities\' languages.' },
};

export const REGIONS: Record<string, GlobeRegion> = {
  ...Object.fromEntries(Object.entries(SOVIET_REPUBLIC_CAPITALS).map(([name, pin]) => [name, { country: 'Soviet Union', areas: [name], pin, standalone: true }])),
  ...Object.fromEntries(Object.entries(YUGOSLAV_REPUBLICS).map(([name, r]) => [name, { country: 'Yugoslavia', ...r }])),
  // Shaded by its own alignment: the Republic of China sided with the West in the Cold War.
  Taiwan: { country: 'China', areas: ['Taiwan'], pin: [121.56, 25.04], bloc: 'western', note: "The Republic of China on Taiwan, allied with the United States by the Mutual Defense Treaty of 1954–1979 and ruled under martial law by the Kuomintang until 1987; shaded by its own alignment." },
  Greenland: { country: 'Denmark', areas: ['Greenland'], pin: [-51.72, 64.18], note: "Part of the Danish realm, with home rule from 1979 and self-government from 2009." },
  Corsica: { country: 'France', areas: [], pin: [8.74, 41.93], note: "A French island, freed by its communist-led Resistance in September 1943, with a movement for autonomy and independence since the 1970s." },
  Sardinia: { country: 'Italy', areas: [], pin: [9.11, 39.22], note: "An autonomous region of Italy since 1948, the island of Antonio Gramsci." },
  Catalonia: { country: 'Spain', areas: [], pin: [2.17, 41.39], note: "Within Spain; its communist party, the PSUC, was a section of the Comintern in its own right, and Barcelona the centre of the POUM." },
  'New Caledonia': { country: 'France', areas: ['New Caledonia'], pin: [166.45, -22.27], note: "A French territory in Melanesia since 1853, where the Kanak independence movement has demanded independence since the 1970s." },
  'Puerto Rico': { country: 'United States', areas: ['Puerto Rico'], pin: [-66.11, 18.47] },
  // Pinned at Praia, and shaded with Guinea-Bissau: the islands are too small to show on this map.
  'Cape Verde': { country: 'Guinea-Bissau', areas: [], pin: [-23.51, 14.93], standalone: true, note: "Independent from Portugal in 1975, ruled by the PAIGC with Guinea-Bissau until 1980 and then by the PAICV as a one-party state until 1991; a member of the Non-Aligned Movement." },
  Hawaii: { country: 'United States', areas: [], pin: [-157.86, 21.31], note: "A US territory until statehood in 1959, where the ILWU and the communists organised the plantation and dock workers; too small to shade on this map." },
};
