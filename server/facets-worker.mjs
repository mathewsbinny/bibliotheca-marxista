/**
 * Counts a search's facets (server/query.mjs, facetQueries) on its own thread and its own
 * connection to the catalogue: over a broad search they take seconds, which on the API's thread
 * would hold up every other request (better-sqlite3 runs queries synchronously).
 */
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { facetQueries } from './query.mjs';

const open = () => {
  const db = new Database(workerData.file, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  return db;
};
let db = open();

parentPort.on('message', ({ id, params, reopen }) => {
  if (reopen) {
    db.close();
    db = open();
    return;
  }
  try {
    const counts = Object.fromEntries(Object.entries(facetQueries(params)).map(([name, q]) => [name, db.prepare(q.sql).all(...q.args).map((r) => [r.value, r.n])]));
    parentPort.postMessage({ id, body: JSON.stringify(counts) });
  } catch (e) {
    parentPort.postMessage({ id, error: e.message });
  }
});
