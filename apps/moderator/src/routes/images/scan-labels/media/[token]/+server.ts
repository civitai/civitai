import type { RequestHandler } from './$types';
import { z } from 'zod';
import { env } from '$env/dynamic/public';
import { getEdgeUrl, getVideoUrls } from '$lib/media/edge-url';
import { mediaForToken, type CardMedia } from '$lib/server/scan-label.service';

// The media of the card a moderator holds, streamed from the CDN under the card's token. Reached
// through the Scan Labels page grant (it sits under that path), and only for the claim's own holder.

const WIDTH = 1200;
const FIT = 'scale-down';

const variantSchema = z.enum(['image', 'mp4', 'webm', 'poster']).catch('image');
type Variant = z.infer<typeof variantSchema>;

/** The same variant the page rendered when it loaded the media itself. */
function upstreamUrl(media: CardMedia, variant: Variant): string {
  if (media.type !== 'video')
    return getEdgeUrl(media.url, {
      width: WIDTH,
      fit: FIT,
      anim: true,
      type: 'image',
      name: media.name,
    });
  const urls = getVideoUrls(media.url, { width: WIDTH, fit: FIT, name: media.name });
  return variant === 'webm' ? urls.webm : variant === 'poster' ? urls.poster : urls.mp4;
}

// Only what the browser needs to play and range-seek; nothing that names the upstream object.
const PASSED_HEADERS = ['content-type', 'content-length', 'accept-ranges', 'content-range'];
// The browser's own, so the CDN negotiates the format it would have for a direct load.
const FORWARDED_REQUEST_HEADERS = ['range', 'accept'];

const absolute = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

const empty = (status: number) =>
  new Response(null, { status, headers: { 'cache-control': 'private, no-store' } });

export const GET: RequestHandler = async ({ params, url, locals, request, fetch }) => {
  if (!locals.user) return empty(401);
  const token = z.string().uuid().safeParse(params.token);
  const media = token.success ? await mediaForToken(token.data, locals.user.id) : null;
  if (!media) return empty(404);
  // Only the CDN itself is ever fetched: a key getEdgeUrl passes through untouched, or a missing
  // base, would otherwise send this request somewhere else, this app included.
  const target = absolute(upstreamUrl(media, variantSchema.parse(url.searchParams.get('v'))));
  const cdn = absolute(env.PUBLIC_IMAGE_LOCATION ?? '');
  if (!target || !cdn || target.origin !== cdn.origin) return empty(404);

  const forwarded = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) forwarded.set(name, value);
  }
  let upstream: Response;
  try {
    upstream = await fetch(target.href, { headers: forwarded });
  } catch {
    return empty(502);
  }
  if (!upstream.ok && upstream.status !== 416) {
    await upstream.body?.cancel();
    // A variant the CDN does not have is missing, not an upstream failure; the page treats both alike.
    return empty(upstream.status === 404 || upstream.status === 410 ? 404 : 502);
  }

  const headers = new Headers({ 'cache-control': 'private, no-store' });
  for (const name of PASSED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  // fetch hands back a decoded body, so an encoded response's length no longer describes it.
  if (upstream.headers.has('content-encoding')) headers.delete('content-length');
  if (request.method === 'HEAD') {
    await upstream.body?.cancel();
    return new Response(null, { status: upstream.status, headers });
  }
  return new Response(upstream.body, { status: upstream.status, headers });
};
