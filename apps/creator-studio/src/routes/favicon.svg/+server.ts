import { buildFaviconSvg } from '@civitai/brand';
import type { RequestHandler } from './$types';

// The Civitai favicon — the diamond "C" badge, sourced from @civitai/brand so this app never duplicates the
// mark. Prerendered to a static `favicon.svg` at build time, so it costs nothing per request.
export const prerender = true;

const FAVICON = buildFaviconSvg();

export const GET: RequestHandler = () =>
  new Response(FAVICON, {
    headers: {
      'content-type': 'image/svg+xml',
      'cache-control': 'public, max-age=604800, immutable',
    },
  });
