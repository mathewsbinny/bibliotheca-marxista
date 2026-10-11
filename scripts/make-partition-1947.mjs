#!/usr/bin/env node
/**
 * Draws Mandate Palestine as divided by the UN Partition Plan of 1947 (General Assembly
 * Resolution 181) for the globe page: a Jewish state, an Arab state and Jerusalem as an
 * international zone (corpus separatum).
 *
 *   node scripts/make-partition-1947.mjs   # writes src/data/partition-1947.json
 *
 * The Jewish state and the Jerusalem zone are traced from the plan's map, accurate to several
 * kilometres; the Arab state is the rest of Mandate Palestine. The Golan Heights, which were never
 * part of Mandate Palestine, are returned to Syria.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import polygonClipping from 'polygon-clipping';
import { feature } from 'topojson-client';

const require = createRequire(import.meta.url);
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const world = require('world-atlas/countries-110m.json');
const atlas = feature(world, world.objects.countries).features;
const area = (name) => {
  const f = atlas.find((x) => x.properties.name === name);
  return f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
};

// The Jewish state: [longitude, latitude].
const JEWISH_NORTH_AND_COAST = [[
  [35.45, 33.09], [35.57, 33.28], // the Lebanese border to Metula
  [35.64, 33.1], [35.65, 32.78], [35.58, 32.64], // the Huleh valley and the Sea of Galilee
  [35.55, 32.42], [35.38, 32.45], [35.2, 32.53], // the Beit She'an valley and the Jezreel valley
  [35.08, 32.42], [35.0, 32.3], [34.95, 32.1], [34.92, 31.95], [34.85, 31.85], // the eastern edge of the coastal plain
  [34.75, 31.8], [34.65, 31.8], // to the coast north of Isdud
  [34.7, 31.92], [34.77, 32.08], [34.85, 32.33], [34.89, 32.5], [34.94, 32.69], [34.99, 32.82], [35.07, 32.86], // up the coast to Haifa
  [35.12, 32.75], [35.2, 32.66], [35.3, 32.645], [35.38, 32.68], [35.42, 32.85], [35.4, 33.0], // round Western Galilee, with Nazareth, which went to the Arab state
  [35.45, 33.09],
]];
const JEWISH_NEGEV = [[
  [34.6, 31.45], [34.68, 31.4], [34.72, 31.2], [34.88, 31.15], [34.95, 31.3], // round Beersheba, which went to the Arab state
  [35.2, 31.33], [35.4, 31.25], [35.43, 31.0], // the southern shore of the Dead Sea
  [35.3, 30.55], [35.15, 30.05], [34.97, 29.55], // down the Wadi Araba to the Gulf of Aqaba
  [34.88, 29.52], [34.65, 30.15], [34.45, 30.85], // inside the Arab strip along the Egyptian border
  [34.5, 31.2], [34.6, 31.45], // east of the Gaza coast
]];
// Jaffa, an enclave of the Arab state within the Jewish coastal plain.
const JAFFA = [[[34.73, 32.03], [34.74, 32.07], [34.78, 32.07], [34.79, 32.03], [34.76, 32.01], [34.73, 32.03]]];
// Jerusalem and Bethlehem, under international administration.
const JERUSALEM = [[[35.13, 31.72], [35.15, 31.84], [35.26, 31.85], [35.29, 31.76], [35.24, 31.69], [35.17, 31.69], [35.13, 31.72]]];
// The Golan Heights: everything east of the Sea of Galilee and the upper Jordan.
const GOLAN = [[[35.66, 32.68], [35.66, 33.4], [36.1, 33.4], [36.1, 32.68], [35.66, 32.68]]];

const pc = polygonClipping;
const modern = pc.union(area('Israel'), area('Palestine'));
const mandate = pc.difference(modern, GOLAN);
const golan = pc.intersection(modern, GOLAN);

const jewish = pc.difference(pc.intersection(pc.union(JEWISH_NORTH_AND_COAST, JEWISH_NEGEV), mandate), JAFFA, JERUSALEM);
const jerusalem = pc.intersection(JERUSALEM, mandate);
const arab = pc.difference(mandate, jewish, jerusalem);
const syria = pc.union(area('Syria'), golan);

// d3-geo wants exterior rings clockwise on the sphere (the opposite of GeoJSON's planar rule).
const forD3 = (multi) => multi.map((polygon) => polygon.map((ring, i) => {
  let a = 0;
  for (let k = 0; k < ring.length - 1; k++) a += ring[k][0] * ring[k + 1][1] - ring[k + 1][0] * ring[k][1];
  return (i === 0) === a < 0 ? ring : [...ring].reverse();
}));
const f = (name, multi) => ({ type: 'Feature', properties: { name }, geometry: { type: 'MultiPolygon', coordinates: forD3(multi) } });

const collection = {
  type: 'FeatureCollection',
  /** Atlas areas these features replace on the globe. */
  replaces: ['Israel', 'Palestine', 'Syria'],
  features: [
    f('Jewish State (1947 plan)', jewish),
    f('Arab State (1947 plan)', arab),
    f('Jerusalem (international zone, 1947 plan)', jerusalem),
    f('Syria', syria),
  ],
};
mkdirSync(join(ROOT, 'src', 'data'), { recursive: true });
writeFileSync(join(ROOT, 'src', 'data', 'partition-1947.json'), JSON.stringify(collection));
console.log(`Jewish State: ${jewish.length} parts; Arab State: ${arab.length} parts; Jerusalem: ${jerusalem.length}; Golan returned to Syria: ${golan.length ? 'yes' : 'not in the atlas outline'}`);
