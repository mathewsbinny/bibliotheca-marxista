import { defineConfig } from 'astro/config';

export default defineConfig({
  // Set this to the deployed URL once hosted (used for canonical links / sitemap).
  site: 'https://bibliothecamarxista.org',
  trailingSlash: 'ignore',
  // In development, the catalogue API (npm run api) answers under /api, as it does behind the
  // deployed site's proxy; a separate API host is set with PUBLIC_API_URL instead.
  vite: {
    // No script is inlined into a page, so the Content Security Policy can allow scripts from the
    // site's own files only (see scripts/write-headers.mjs).
    build: { assetsInlineLimit: 0 },
    // The API's paths: the catalogue API itself, titles' pages and their sitemaps.
    server: { proxy: Object.fromEntries(['/api', '/book', '/sitemap-books'].map((p) => [p, 'http://localhost:8787'])) },
    preview: { proxy: Object.fromEntries(['/api', '/book', '/sitemap-books'].map((p) => [p, 'http://localhost:8787'])) },
  },
});
