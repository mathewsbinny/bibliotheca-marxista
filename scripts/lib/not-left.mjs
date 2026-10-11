// Authors outside the scope of Bibliotheca Marxista: fascists and Nazis, conservatives and other right-wingers, and
// liberals. Each entry: [name, kind, other spellings…]. Matched against catalogue credits and pages.
// A catalogue title whose first credit is one of them is dropped; where they are only a later credit
// (an anthology, a correspondence, a trial record or a document published to expose them) only their
// name is removed. CREDIT_ONLY names are always removed as a credit, never with the title.
export const NOT_LEFT = [
  // Fascists, Nazis and the far right
  ['Adolf Hitler', 'fascist', 'Hitler, Adolf'], ['Joseph Goebbels', 'fascist', 'Paul Joseph Goebbels', 'Josef Goebbels'], ['Hermann Göring', 'fascist', 'Hermann Goering'],
  ['Heinrich Himmler', 'fascist'], ['Alfred Rosenberg', 'fascist'], ['Rudolf Hess', 'fascist', 'Rudolf Heß'], ['Albert Speer', 'fascist'], ['Martin Bormann', 'fascist'],
  ['Reinhard Heydrich', 'fascist'], ['Adolf Eichmann', 'fascist'], ['Rudolf Höss', 'fascist', 'Rudolf Höß', 'Rudolf Hoess'], ['Hans Frank', 'fascist'],
  ['Julius Streicher', 'fascist'], ['Joachim von Ribbentrop', 'fascist'], ['Gregor Strasser', 'fascist'], ['Otto Strasser', 'fascist'], ['Ernst Röhm', 'fascist'],
  ['Dietrich Eckart', 'fascist'], ['Gottfried Feder', 'fascist'], ['Houston Stewart Chamberlain', 'fascist'], ['Arthur de Gobineau', 'fascist', 'Joseph Arthur de Gobineau'],
  ['Hans F. K. Günther', 'fascist', 'Hans Friedrich Karl Günther'], ['Richard Walther Darré', 'fascist', 'Walther Darré'], ['Baldur von Schirach', 'fascist'],
  ['Robert Ley', 'fascist'], ['Wilhelm Frick', 'fascist'], ['Carl Schmitt', 'fascist'], ['Martin Heidegger', 'fascist'], ['Ernst Jünger', 'fascist'],
  ['Oswald Spengler', 'fascist'], ['Arthur Moeller van den Bruck', 'fascist'], ['Hjalmar Schacht', 'fascist'], ['Franz von Papen', 'fascist'], ['Erich Ludendorff', 'fascist'],
  ['Benito Mussolini', 'fascist'], ['Giovanni Gentile', 'fascist'], ['Gabriele D\'Annunzio', 'fascist'], ['Filippo Tommaso Marinetti', 'fascist', 'F. T. Marinetti'],
  ['Julius Evola', 'fascist'], ['Italo Balbo', 'fascist'], ['Galeazzo Ciano', 'fascist'], ['Roberto Farinacci', 'fascist'], ['Alfredo Rocco', 'fascist'], ['Giorgio Almirante', 'fascist'],
  ['Ezra Pound', 'fascist'], ['Francisco Franco', 'fascist'], ['José Antonio Primo de Rivera', 'fascist'], ['Ramiro Ledesma Ramos', 'fascist'], ['Onésimo Redondo', 'fascist'],
  ['Ernesto Giménez Caballero', 'fascist'], ['Charles Maurras', 'fascist'], ['Maurice Barrès', 'fascist'], ['Robert Brasillach', 'fascist'], ['Pierre Drieu La Rochelle', 'fascist'],
  ['Louis-Ferdinand Céline', 'fascist'], ['Lucien Rebatet', 'fascist'], ['Marcel Déat', 'fascist'], ['Jacques Doriot', 'fascist'], ['Philippe Pétain', 'fascist'],
  ['Pierre Laval', 'fascist'], ['Georges Valois', 'fascist'], ['Léon Degrelle', 'fascist'], ['Vidkun Quisling', 'fascist'], ['Knut Hamsun', 'fascist'],
  ['Oswald Mosley', 'fascist'], ['A. K. Chesterton', 'fascist'], ['Arnold Leese', 'fascist'], ['William Joyce', 'fascist'], ['Corneliu Zelea Codreanu', 'fascist', 'Corneliu Codreanu'],
  ['Ion Antonescu', 'fascist'], ['Horia Sima', 'fascist'], ['Mircea Eliade', 'fascist'], ['Emil Cioran', 'fascist', 'E. M. Cioran'], ['Ante Pavelić', 'fascist'],
  ['Ferenc Szálasi', 'fascist'], ['Miklós Horthy', 'fascist'], ['Engelbert Dollfuss', 'fascist', 'Engelbert Dollfuß'], ['Kurt Schuschnigg', 'fascist', 'Kurt von Schuschnigg'],
  ['Othmar Spann', 'fascist'], ['António de Oliveira Salazar', 'fascist', 'Oliveira Salazar'], ['Plínio Salgado', 'fascist'], ['Gustavo Barroso', 'fascist'],
  ['Savitri Devi', 'fascist'], ['George Lincoln Rockwell', 'fascist'], ['William Luther Pierce', 'fascist'], ['Francis Parker Yockey', 'fascist'],
  ['William Gayley Simpson', 'fascist'], ['David Duke', 'fascist'], ['Jean-Marie Le Pen', 'fascist'], ['Alain de Benoist', 'fascist'], ['Hideki Tojo', 'fascist'],
  ['Ikki Kita', 'fascist', 'Kita Ikki'], ['Wang Jingwei', 'fascist'], ['Augusto Pinochet', 'fascist'], ['Alfredo Stroessner', 'fascist'], ['Pascal Gauchon', 'fascist'],
  ['Konrad Lorenz', 'fascist'], ['Friedrich von Gottl-Ottlilienfeld', 'fascist'], ['Curzio Malaparte', 'fascist'], ['Hans Grimm', 'fascist'],
  ['Alexandre Zévaès', 'fascist'], ['Maurice Lime', 'fascist'], ['Alf Amble', 'fascist'], ['Hanns Sassmann', 'fascist', 'Hanns Saßmann'],
  ['Horst Mahler', 'fascist'], ['Viktor Filatov', 'fascist', 'Viktor Ivanovich Filatov'], ['Erwin Guido Kolbenheyer', 'fascist'],
  ['Josef Pfitzner', 'fascist'], ['Ugo Cavallero', 'fascist'], ['Pál Prónay', 'fascist', 'Pal Prónay'], ['Franz Halder', 'fascist'], ['André Jolles', 'fascist'], ['Hermann Bengtson', 'fascist'],
  // Conservatives and other right-wingers
  ['Burhanuddin Rabbani', 'conservative', 'Burhān al-Dīn Rabbānī', 'Burhānuddīn Rabbānī'], ['Gulbuddin Hekmatyar', 'conservative', 'Gulbuddīn Ḥikmatyār'], ['Abdul Rasul Sayyaf', 'conservative'], ['Ahmad Shah Massoud', 'conservative', 'Aḥmad Shāh Masʻūd'],
  ['Edmund Burke', 'conservative'], ['Joseph de Maistre', 'conservative'], ['Louis de Bonald', 'conservative'], ['Thomas Carlyle', 'conservative'], ['Benjamin Disraeli', 'conservative'],
  ['Winston Churchill', 'conservative', 'Winston S. Churchill'], ['Margaret Thatcher', 'conservative'], ['Ronald Reagan', 'conservative'], ['Richard Nixon', 'conservative', 'Richard M. Nixon'],
  ['Henry Kissinger', 'conservative', 'Henry A. Kissinger'], ['Zbigniew Brzezinski', 'conservative'], ['Konrad Adenauer', 'conservative'], ['Otto von Bismarck', 'conservative'],
  ['Charles de Gaulle', 'conservative'], ['Russell Kirk', 'conservative'], ['William F. Buckley Jr.', 'conservative', 'William F. Buckley'], ['Leo Strauss', 'conservative'],
  ['Michael Oakeshott', 'conservative'], ['Roger Scruton', 'conservative'], ['Samuel P. Huntington', 'conservative', 'Samuel Huntington'], ['Irving Kristol', 'conservative'],
  ['Norman Podhoretz', 'conservative'], ['Allan Bloom', 'conservative'], ['Whittaker Chambers', 'conservative'], ['James Burnham', 'conservative'],
  ['Aleksandr Solzhenitsyn', 'conservative', 'Alexander Solzhenitsyn', 'Alexandre Soljénitsyne', 'Alexander Solschenizyn', 'Aleksandr Isaevič Solženicyn'],
  ['Ivan Ilyin', 'conservative'], ['Konstantin Pobedonostsev', 'conservative'], ['Pyotr Stolypin', 'conservative'], ['Juan Donoso Cortés', 'conservative'],
  ['Józef Piłsudski', 'conservative'], ['Roman Dmowski', 'conservative'], ['Ayn Rand', 'conservative'], ['Barry Goldwater', 'conservative'], ['J. Edgar Hoover', 'conservative'],
  ['Joseph McCarthy', 'conservative'], ['Chiang Kai-shek', 'conservative'], ['Syngman Rhee', 'conservative'], ['Ngo Dinh Diem', 'conservative'], ['Francis Fukuyama', 'conservative'],
  ['Dwight D. Eisenhower', 'conservative'], ['Herbert Hoover', 'conservative'], ['John Foster Dulles', 'conservative'], ['George F. Kennan', 'conservative'],
  ['Richard Pipes', 'conservative'], ['Robert Conquest', 'conservative'], ['Leszek Kołakowski', 'conservative'], ['Arthur Koestler', 'liberal'], ['Boris Yeltsin', 'conservative'],
  ['Lech Wałęsa', 'conservative'], ['Jacek Kuroń', 'liberal'], ['Massimo Cacciari', 'liberal'], ['David Rousset', 'conservative'], ['Vasil Bykau', 'conservative', 'Vasil Bykaŭ', 'Vasil Bykov', 'Vasilʹ Bykov'],
  ['Aleksandr Vladislavlev', 'conservative'], ['Viktor Kulikov', 'conservative'], ['Jaak Jõerüüt', 'liberal'], ['Tiit Made', 'conservative'], ['Petro Tolochko', 'conservative'],
  ['Rostislav Petera', 'conservative'], ['Károly Király', 'conservative'], ['Salah El-Ouadie', 'conservative'], ['Florbela Malaquias', 'conservative'], ['Eldridge Cleaver', 'conservative'], ['Lucio Colletti', 'conservative'], ['Aldo Brandirali', 'conservative'], ['Ramón Tamames', 'conservative'], ['Heinrich von Treitschke', 'conservative'], ['Friedrich Nietzsche', 'conservative'], ['Arthur Schopenhauer', 'conservative'],
  ['Pope Pius XII', 'conservative'], ['Pius XI', 'conservative'], ['Thomas Malthus', 'conservative', 'Thomas Robert Malthus', 'T. R. Malthus'],
  // Liberals
  ['John Locke', 'liberal'], ['Adam Smith', 'liberal'], ['David Ricardo', 'liberal'], ['Jean-Baptiste Say', 'liberal'], ['Frédéric Bastiat', 'liberal'],
  ['Jeremy Bentham', 'liberal'], ['John Stuart Mill', 'liberal', 'J. S. Mill'], ['Herbert Spencer', 'liberal'], ['Alexis de Tocqueville', 'liberal'], ['Benjamin Constant', 'liberal'],
  ['Friedrich Hayek', 'liberal', 'Friedrich A. Hayek', 'F. A. Hayek', 'Friedrich August von Hayek'], ['Ludwig von Mises', 'liberal'], ['Milton Friedman', 'liberal'],
  ['Karl Popper', 'liberal', 'Karl R. Popper'], ['Isaiah Berlin', 'liberal'], ['Raymond Aron', 'liberal'], ['John Maynard Keynes', 'liberal', 'J. M. Keynes'],
  ['John Rawls', 'liberal'], ['Robert Nozick', 'liberal'], ['Woodrow Wilson', 'liberal'], ['Franklin D. Roosevelt', 'liberal', 'Franklin Delano Roosevelt'],
  ['John F. Kennedy', 'liberal'], ['Lyndon B. Johnson', 'liberal'], ['Arthur M. Schlesinger Jr.', 'liberal', 'Arthur Schlesinger'], ['Walter Lippmann', 'liberal'],
  ['Max Weber', 'liberal'], ['Friedrich Naumann', 'liberal'], ['Gustav Stresemann', 'liberal'], ['Ralf Dahrendorf', 'liberal'], ['Thomas Jefferson', 'liberal'],
  ['Montesquieu', 'liberal'], ['Voltaire', 'liberal'], ['Ludwig Erhard', 'liberal'], ['Wilhelm Röpke', 'liberal'], ['Walter Eucken', 'liberal'], ['Joseph Schumpeter', 'liberal', 'Joseph A. Schumpeter'],
  ['Alfred Marshall', 'liberal'], ['Vilfredo Pareto', 'fascist'], ['Gaetano Mosca', 'conservative'], ['Benedetto Croce', 'liberal'], ['José Ortega y Gasset', 'liberal'],
  ['Mario Vargas Llosa', 'liberal'], ['Octavio Paz', 'liberal'], ['Václav Havel', 'liberal'], ['Andrei Sakharov', 'liberal'],
];

// People of the left who later moved right: their works up to this year (their left years) stay,
// later ones go. Titles without a year are kept.
export const LEFT_UNTIL = {
  'Jacques Doriot': 1934, 'Alexandre Zévaès': 1940, 'Maurice Lime': 1936, 'Horst Mahler': 1996, 'Arthur Koestler': 1941,
  'Leszek Kołakowski': 1968, 'Aldo Brandirali': 1976, 'Lucio Colletti': 1985, 'Eldridge Cleaver': 1975, 'Ramón Tamames': 1981,
  'Viktor Filatov': 1988, 'James Burnham': 1940, 'Jacek Kuroń': 1989, 'Massimo Cacciari': 1990, 'David Rousset': 1967,
  'Vasil Bykau': 1991, 'Aleksandr Vladislavlev': 1991, 'Viktor Kulikov': 1991, 'Jaak Jõerüüt': 1991, 'Tiit Made': 1987,
  'Petro Tolochko': 1991, 'Rostislav Petera': 1989, 'Károly Király': 1989, 'Salah El-Ouadie': 2007,
};

// Subjects or co-signatories of left publications, credited by library catalogues as their authors.
export const CREDIT_ONLY = ['Hermann Göring', 'Adolf Eichmann', 'Herbert von Dirksen', 'Ronald Reagan', 'Francis Fukuyama', 'Richard Pipes', 'Otto Strasser',
  'Winston Churchill', 'Franklin D. Roosevelt', 'Adolf Hitler'];
// Single titles: [title pattern, credited name] dropped outright.
export const DROP_TITLES = [
  [/^Die Entlarvung einer Legende von einem deutschen Politiker$/, 'Adolf Hitler'], // Malik 1933: a duplicate of Hitler, der Eroberer, credited to its subject
  [/^Dziennik wojenny$/, 'Hans-Adolf Jacobsen'], // Franz Halder's war diary, edited by Jacobsen
  [/^KL Auschwitz Seen by the SS$/, 'Rudolf Höss'], // the testimonies of Höss, Broad and Kremer
];
// Left works crediting one of them first: [title pattern, credit to remove].
export const KEEP_TITLES = [
  [/^Produktion auf grosser und kleiner Stufenleiter$/, 'John Stuart Mill'], // Chernyshevsky's commentary on Mill
  [/^La Transici[oó]n del Esclavismo al Feudalismo/, 'Max Weber'], // a Marxist anthology including Weber
];

const fold = (s) => String(s).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/['’ʹʼ]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const creditKey = (a) => {
  let n = String(a).replace(/,?\s*\(?\d{4}\s*-\s*(\d{4})?\)?\.?/g, '').replace(/\s*\[[^\]]*\]/g, '').trim();
  const p = n.split(/\s*,\s*/); if (p.length === 2) n = `${p[1]} ${p[0]}`;
  return fold(n);
};
const WHO = new Map();
for (const [name, kind, ...alt] of NOT_LEFT) for (const n of [name, ...alt]) WHO.set(fold(n), { name, kind });
const CREDIT_ONLY_KEYS = new Set(CREDIT_ONLY.map(fold));
export const notLeftCredit = (a, year) => {
  const w = WHO.get(creditKey(a));
  if (!w) return undefined;
  const until = LEFT_UNTIL[w.name];
  return until && (year == null || year <= until) ? undefined : w;
};

/** Returns the title with out-of-scope credits removed, or null when the title itself goes. */
export function screenTitle(t) {
  const credits = [...(t.authors ?? []), ...(t.editors ?? [])];
  if (DROP_TITLES.some(([re, who]) => re.test(t.title) && credits.some((a) => creditKey(a) === fold(who)))) return null;
  const kept = KEEP_TITLES.some(([re, who]) => re.test(t.title) && credits.some((a) => creditKey(a) === fold(who)));
  const first = (t.authors ?? [])[0];
  const bad = (a) => notLeftCredit(a, t.year);
  if (!kept && first && bad(first) && !CREDIT_ONLY_KEYS.has(fold(bad(first).name))) return null;
  const keep = (a) => !bad(a);
  if (!credits.some((a) => !keep(a))) return t;
  const out = { ...t };
  if (t.authors) out.authors = t.authors.filter(keep);
  if (t.editors) out.editors = t.editors.filter(keep);
  if (out.editors && !out.editors.length) delete out.editors;
  return out;
}
