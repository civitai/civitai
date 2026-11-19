import type { SafeFetchOptions } from '~/server/utils/safe-fetch';
import { safeFetch } from '~/server/utils/safe-fetch';
import { bandcampPlayerUrl, parseBandcampPageUrl } from '~/shared/utils/embed-providers';

export type BandcampLookupResult =
  | { ok: true; playerUrl: string }
  | { ok: false; reason: 'invalid-url' | 'unavailable' | 'not-found' };

// allowUrl holds every hop, redirects included, on Bandcamp hosts; safeFetch's SSRF guard alone
// would follow a redirect to any public site.
export const BANDCAMP_FETCH_OPTIONS: SafeFetchOptions = {
  timeoutMs: 5_000,
  maxBytes: 1_000_000,
  allowedContentTypes: ['text/html'],
  maxRedirects: 2,
  allowUrl: (url) => !!parseBandcampPageUrl(url.toString()),
};

export async function resolveBandcampEmbed(
  pageUrl: string,
  fetchPage: typeof safeFetch = safeFetch
): Promise<BandcampLookupResult> {
  const url = parseBandcampPageUrl(pageUrl);
  if (!url) return { ok: false, reason: 'invalid-url' };
  let html: string;
  try {
    html = (await fetchPage(url.toString(), BANDCAMP_FETCH_OPTIONS)).bytes.toString('utf8');
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  const item = findBandcampItem(html);
  return item
    ? { ok: true, playerUrl: bandcampPlayerUrl(item.type, item.id) }
    : { ok: false, reason: 'not-found' };
}

/**
 * The item id is read from the page, the player URL is built by us: nothing from the page is
 * echoed back except a type and a run of digits.
 */
export function findBandcampItem(html: string): { type: 'track' | 'album'; id: string } | null {
  const player = /bandcamp\.com\/EmbeddedPlayer\/(?:v=2\/)?(track|album)=(\d{1,20})\b/.exec(html);
  if (player) return { type: player[1] as 'track' | 'album', id: player[2] };
  // bc-page-properties is HTML-escaped JSON: {"item_type":"t","item_id":123,...}
  const props = /name="bc-page-properties"\s+content="([^"]*)"/.exec(html)?.[1];
  if (!props) return null;
  const decoded = props.replace(/&quot;/g, '"');
  const type = /"item_type":"([ta])"/.exec(decoded)?.[1];
  const id = /"item_id":(\d{1,20})\b/.exec(decoded)?.[1];
  if (!type || !id) return null;
  return { type: type === 't' ? 'track' : 'album', id };
}
