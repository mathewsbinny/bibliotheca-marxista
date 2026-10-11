#!/usr/bin/env node
/**
 * Splits Germany on the world atlas into West and East Germany along the inner German border
 * (1949–1990), with West Berlin as a western enclave, for the globe page.
 *
 *   node scripts/make-divided-germany.mjs   # writes src/data/divided-germany.json
 *
 * The border is traced from places on either side of it, accurate to a few kilometres — finer
 * than the 1:110m atlas it is drawn on.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import polygonClipping from 'polygon-clipping';
import { feature } from 'topojson-client';

const require = createRequire(import.meta.url);
const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const world = require('world-atlas/countries-110m.json');

// The inner German border, north to south: [longitude, latitude].
const BORDER = [
  [10.93, 54.3], // out in the Baltic, so the cut starts beyond the coast
  [10.92, 53.95], // Priwall (West) / Pötenitz (East)
  [10.83, 53.88], // Lübeck-Schlutup (West) / Selmsdorf (East)
  [10.8, 53.72], // east of the Ratzeburger See
  [10.9, 53.62], [10.96, 53.55], // across the Schaalsee
  [10.85, 53.45], [10.68, 53.37], // to the Elbe between Lauenburg (West) and Boizenburg (East)
  [10.9, 53.28], [11.04, 53.16], [11.25, 53.13], [11.45, 53.06], [11.57, 53.04], // up the Elbe to Schnackenburg
  [11.6, 52.98], [11.4, 52.95], [11.1, 52.9], [10.95, 52.85], // round the Wendland, north of Salzwedel (East)
  [10.85, 52.8], [10.76, 52.72], [10.96, 52.6], [10.97, 52.45], // Wittingen and Brome (West), Oebisfelde (East)
  [11.04, 52.3], [11.06, 52.22], [11.0, 52.1], [10.93, 52.0], // Helmstedt (West) / Marienborn (East)
  [10.67, 52.0], [10.62, 51.9], // Hornburg and Bad Harzburg (West), Osterwieck and Ilsenburg (East)
  [10.58, 51.8], [10.66, 51.73], [10.65, 51.58], // across the Harz: Torfhaus and Braunlage (West), the Brocken (East)
  [10.5, 51.55], [10.33, 51.53], [10.25, 51.48], // the Eichsfeld, east of Duderstadt
  [10.05, 51.4], [9.93, 51.33], [9.95, 51.22], [10.03, 51.12], // the Werra valley
  [10.2, 51.02], [10.05, 50.95], [10.0, 50.86], [9.92, 50.7], // Herleshausen and Philippsthal (West), Vacha (East)
  [10.05, 50.62], [10.2, 50.57], [10.35, 50.48], [10.4, 50.4], // the Rhön, north of Mellrichstadt
  [10.6, 50.33], [10.75, 50.33], [10.95, 50.37], [11.1, 50.36], // north of Coburg (West), south of Sonneberg (East)
  [11.25, 50.3], [11.3, 50.4], [11.35, 50.5], [11.5, 50.5], // round Ludwigsstadt (West) below Probstzella (East)
  [11.6, 50.42], [11.7, 50.39], [11.85, 50.38], [12.0, 50.33], // Blankenstein and Hirschberg (East), Hof (West)
  [12.1, 50.32], // the tripoint with Czechoslovakia
  [12.15, 50.2], // into Czechoslovakia, so the cut ends beyond the frontier
];
// Everything east of the border line, as a polygon closed far to the east.
const EAST_OF_BORDER = [[...BORDER, [16, 50], [16, 55], [10.93, 55], BORDER[0]]];

// West Berlin, an enclave of the West inside the East.
const WEST_BERLIN = [[
  [13.09, 52.42], [13.12, 52.53], [13.13, 52.58], [13.2, 52.62], [13.28, 52.66], [13.35, 52.65],
  [13.38, 52.57], [13.41, 52.53], [13.43, 52.49], [13.47, 52.47], [13.45, 52.42], [13.38, 52.38],
  [13.25, 52.39], [13.15, 52.4], [13.09, 52.42],
]];

const germany = feature(world, world.objects.countries).features.find((f) => f.properties.name === 'Germany');
const outline = germany.geometry.type === 'Polygon' ? [germany.geometry.coordinates] : germany.geometry.coordinates;

const east = polygonClipping.difference(polygonClipping.intersection(outline, EAST_OF_BORDER), WEST_BERLIN);
const west = polygonClipping.union(polygonClipping.difference(outline, EAST_OF_BORDER), WEST_BERLIN);

// d3-geo wants exterior rings clockwise on the sphere (the opposite of GeoJSON's planar rule).
const forD3 = (multi) => multi.map((polygon) => polygon.map((ring, i) => {
  let area = 0;
  for (let k = 0; k < ring.length - 1; k++) area += ring[k][0] * ring[k + 1][1] - ring[k + 1][0] * ring[k][1];
  const clockwise = area < 0;
  return (i === 0) === clockwise ? ring : [...ring].reverse();
}));

const collection = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { name: 'West Germany' }, geometry: { type: 'MultiPolygon', coordinates: forD3(west) } },
    { type: 'Feature', properties: { name: 'East Germany' }, geometry: { type: 'MultiPolygon', coordinates: forD3(east) } },
  ],
};
mkdirSync(join(ROOT, 'src', 'data'), { recursive: true });
writeFileSync(join(ROOT, 'src', 'data', 'divided-germany.json'), JSON.stringify(collection));
console.log(`West Germany: ${west.length} polygons (incl. West Berlin); East Germany: ${east.length} polygon(s), ${east[0].length} rings`);
