/**
 * The sitemap for search engines: the main pages and every publisher, author, movement and
 * international. Titles are reached through their publishers' and authors' pages.
 */
import type { APIRoute } from 'astro';
import { getAuthors, getInternationals, getMovements, getPublishers } from '../lib/catalogue';

export const GET: APIRoute = async ({ site }) => {
  const paths = [
    '/', '/publishers', '/titles', '/authors', '/international', '/resources', '/about',
    ...(await getPublishers()).map((p) => `/publishers/${p.id}`),
    ...(await getAuthors()).map((a) => `/authors/${a.id}`),
    ...(await getMovements()).map((m) => `/movements/${m.id}`),
    ...(await getInternationals()).map((i) => `/international/${i.id}`),
  ];
  const urls = paths.map((p) => `  <url><loc>${new URL(p, site).href}</loc></url>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
