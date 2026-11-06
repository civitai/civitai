import { bandcampPlayerUrl, parseBandcampPageUrl } from '~/shared/utils/embed-providers';

// Outbound fetch from our server on a user-supplied URL, so every hop is held to Bandcamp's own
// hosts (parseBandcampPageUrl: https, bandcamp.com or one-label *.bandcamp.com, no userinfo or
// port) BEFORE its socket opens. Redirects are followed by hand for that reason.
const MAX_REDIRECTS = 2;
const TIMEOUT_MS = 5_000;
const MAX_BYTES = 1_000_000;

export type BandcampLookupResult =
  | { ok: true; playerUrl: string }
  | { ok: false; reason: 'invalid-url' | 'unavailable' | 'not-found' };

export async function resolveBandcampEmbed(
  pageUrl: string,
  fetchImpl: typeof fetch = fetch
): Promise<BandcampLookupResult> {
  const first = parseBandcampPageUrl(pageUrl);
  if (!first) return { ok: false, reason: 'invalid-url' };
  let url: URL = first;

  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    for (let hop = 0; ; hop++) {
      const response: Response = await fetchImpl(url.toString(), {
        redirect: 'manual',
        signal,
        headers: { accept: 'text/html' },
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location: string | null = response.headers.get('location');
        const next: URL | null =
          location && hop < MAX_REDIRECTS ? safeResolve(location, url) : null;
        if (!next) return { ok: false, reason: 'unavailable' };
        url = next;
        continue;
      }
      if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) {
        await response.body?.cancel();
        return { ok: false, reason: 'unavailable' };
      }
      const html = await readCapped(response, signal);
      if (html === null) return { ok: false, reason: 'unavailable' };
      const item = findBandcampItem(html);
      return item
        ? { ok: true, playerUrl: bandcampPlayerUrl(item.type, item.id) }
        : { ok: false, reason: 'not-found' };
    }
  } catch {
    // Timeout, DNS, TLS, reset: all mean the same thing to the editor.
    return { ok: false, reason: 'unavailable' };
  }
}

function safeResolve(location: string, base: URL) {
  try {
    return parseBandcampPageUrl(new URL(location, base).toString());
  } catch {
    return null;
  }
}

async function readCapped(response: Response, signal: AbortSignal): Promise<string | null> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_BYTES) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  if (signal.aborted) return null;
  return new TextDecoder().decode(Buffer.concat(chunks));
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
