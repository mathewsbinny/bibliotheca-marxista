import type { APIRoute } from 'astro';
import { getAuthors, getTitlesByAuthor } from '../../lib/catalogue';

/** Every author, alphabetically, with their book counts: the full list on the authors page. */
export const GET: APIRoute = async () => {
  const authors = await Promise.all(
    (await getAuthors()).map(async (a) => {
      const editions = await getTitlesByAuthor(a);
      return {
        id: a.id,
        name: a.data.name,
        nationality: a.data.nationality,
        born: a.data.born,
        died: a.data.died,
        active: a.data.active,
        books: editions.length,
        verified: editions.filter((t) => t.verified).length,
      };
    }),
  );
  return new Response(JSON.stringify(authors), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
};
