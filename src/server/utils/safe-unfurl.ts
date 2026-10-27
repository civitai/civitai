import { unfurl } from 'unfurl.js';
import { safeFetch } from '~/server/utils/safe-fetch';

/**
 * Link previews for chat. unfurl.js fetches the page and then any oEmbed document the
 * page points at; both go through `opts.fetch`, so both get safeFetch's controls
 * (https only, public addresses only, pinned socket, capped body and redirects).
 */
export function safeUnfurl(href: string) {
  return unfurl(href, { fetch: unfurlFetch });
}

/** The `fetch` unfurl.js calls: safeFetch, wrapped in the Response shape it reads. */
export async function unfurlFetch(href: string) {
  const url = new URL(href);
  // linkify gives a bare `github.com/x` as http://; every previewed host serves https.
  if (url.protocol === 'http:') url.protocol = 'https:';
  const { bytes, contentType } = await safeFetch(url.toString(), {
    timeoutMs: 5000,
    maxBytes: 2 * 1024 * 1024,
    allowedContentTypes: [
      'text/html',
      'application/xhtml+xml',
      'application/json',
      'text/xml',
      'application/xml',
    ],
    maxRedirects: 2,
  });
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { 'content-type': contentType },
  });
}
