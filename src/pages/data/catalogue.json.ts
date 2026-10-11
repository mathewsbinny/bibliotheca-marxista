import type { APIRoute } from 'astro';
import { getAuthors, getPublishers, getTitlesByPublisher } from '../../lib/catalogue';
import { chunkCount } from '../../lib/shard';

/**
 * Every publisher's record, with the number of its titles and of its title data files
 * (/data/titles/<id>/<n>.json): the index scripts/build-db.mjs builds the catalogue database from.
 */
export const GET: APIRoute = async () => {
  const byPublisher = await getTitlesByPublisher();
  const publishers = (await getPublishers()).map((p) => {
    const titles = byPublisher.get(p.id)?.length ?? 0;
    return {
      id: p.id,
      ...p.data,
      predecessor: p.data.predecessor?.id,
      successor: p.data.successor?.id,
      parent: p.data.parent?.id,
      international: p.data.international?.id,
      titles,
      chunks: chunkCount(titles),
    };
  });
  const authors = (await getAuthors()).length;
  const titles = publishers.reduce((n, p) => n + p.titles, 0);
  return new Response(JSON.stringify({ counts: { publishers: publishers.length, authors, titles }, publishers }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
