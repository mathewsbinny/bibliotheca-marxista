#!/usr/bin/env node
/**
 * Writes dist/_headers, the security headers the static host (Cloudflare Pages or Netlify) sends with
 * every page: a Content Security Policy allowing scripts, styles and media from the site alone and
 * requests to the catalogue API alone, and protection against framing, sniffing and leaking referrers.
 * The API's address comes from PUBLIC_API_URL, as for the pages (same origin when it is unset).
 *
 * Run after `astro build` (npm run build does). The pages contain no inline script or style for the
 * policy to allow: Astro is told to inline none (vite.build.assetsInlineLimit in astro.config.mjs),
 * and the build fails here if one appears.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = join(new URL('..', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), 'dist');
const api = process.env.PUBLIC_API_URL ? new URL(process.env.PUBLIC_API_URL).origin : '';

// Inline code the policy would block: <script> without src that the browser runs, and <style>.
const inline = [];
for (const f of readdirSync(DIST, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.html'))) {
  const html = readFileSync(join(DIST, f), 'utf8');
  if (/<script(?![^>]*\bsrc=)(?![^>]*type="application\/(ld\+)?json")[^>]*>/.test(html) || /<style[\s>]/.test(html) || /\sstyle="/.test(html)) inline.push(f);
}
if (inline.length) {
  console.error(`Inline scripts or styles, which the Content Security Policy would block, in ${inline.length} pages, e.g. ${inline.slice(0, 3).join(', ')}`);
  process.exit(1);
}

const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "media-src 'self'",
  "font-src 'self'",
  `connect-src 'self'${api ? ` ${api}` : ''}`,
  // The data download is a form sent to the API.
  `form-action 'self'${api ? ` ${api}` : ''}`,
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

writeFileSync(join(DIST, '_headers'), `/*
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  Cross-Origin-Opener-Policy: same-origin
  Strict-Transport-Security: max-age=31536000; includeSubDomains

/_astro/*
  Cache-Control: public, max-age=31536000, immutable
`);
console.log(`Security headers written to dist/_headers${api ? ` (API at ${api})` : ''}`);
