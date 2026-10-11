/**
 * The sitemap index for search engines: the sitemap of the site's pages (/sitemap-pages.xml) and the
 * sitemaps of every title's page, 50,000 titles to each, which the catalogue API serves
 * (/sitemap-books-<n>.xml, see server/server.mjs).
 */
import type { APIRoute } from 'astro';
import { getTitles } from '../lib/catalogue';

const TITLES_PER_SITEMAP = 50_000;

export const GET: APIRoute = async ({ site }) => {
  const books = Math.ceil((await getTitles()).length / TITLES_PER_SITEMAP);
  const sitemaps = ['/sitemap-pages.xml', ...Array.from({ length: books }, (_, i) => `/sitemap-books-${i + 1}.xml`)];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + sitemaps.map((p) => `  <sitemap><loc>${new URL(p, site).href}</loc></sitemap>`).join('\n') + '\n</sitemapindex>\n';
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
