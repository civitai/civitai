import * as z from 'zod';
import { POST_TAG_LIMIT } from '~/server/common/constants';
import type { ExternalMetaSchema } from '~/server/schema/image.schema';
import { APP_SUB_LISTING_EXTERNAL_ID_RE } from '~/shared/constants/app-sub-listing.constants';
import { sniffImageFormat } from '~/shared/utils/image-magic-bytes';
import { POST_INTENT_MAX_MEDIA } from '~/shared/utils/post-intent';

export const POST_INTENT_MANIFEST_MAX_BYTES = 64 * 1024;
export const POST_INTENT_IMAGE_MAX_BYTES = 50 * 1024 ** 2;
export const POST_INTENT_VIDEO_MAX_BYTES = 200 * 1024 ** 2;
export const POST_INTENT_CONNECT_TIMEOUT_MS = 10_000;
export const POST_INTENT_ITEM_TIMEOUT_MS = 120_000;
export const POST_INTENT_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
const DETAILS_LIMIT = 10;

export type PostIntentRefusalCode =
  | 'not-approved'
  | 'outside-prefix'
  | 'bad-manifest'
  | 'app-mismatch'
  | 'expired'
  | 'claimed'
  | 'already-posted'
  | 'fetch-failed'
  | 'unsupported-media'
  | 'too-large'
  | 'video-limits'
  | 'rate-limited'
  | 'busy'
  | 'not-staged';

export class PostIntentRefusal extends Error {
  constructor(readonly code: PostIntentRefusalCode, message: string) {
    super(message);
    this.name = 'PostIntentRefusal';
  }
}

export type AppPostIntentRecord = {
  listingId: string;
  listingName: string;
  appId: string;
  host: string;
  pathPrefix: string;
};

function parseHttpsUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return null;
  return url;
}

/** An app's server may decode percent-encoding into a different path, so none is accepted. */
const hasPercentEncoding = (pathname: string) => pathname.includes('%');

export function isUnderAppPrefix(
  raw: string,
  record: Pick<AppPostIntentRecord, 'host' | 'pathPrefix'>
) {
  const url = parseHttpsUrl(raw);
  if (!url) return false;
  if (url.hostname !== record.host) return false;
  if (hasPercentEncoding(url.pathname) || url.pathname.includes('\\')) return false;
  return (
    url.pathname.startsWith(record.pathPrefix) && url.pathname.length > record.pathPrefix.length
  );
}

/**
 * The one form a manifest URL is looked up and stored under, so variants of the same file (a
 * fragment, host case) cannot claim or post it again. Null when the URL has a query or encoding.
 */
export function canonicalManifestUrl(raw: string): string | null {
  const url = parseHttpsUrl(raw);
  if (!url || url.search || hasPercentEncoding(url.pathname) || url.pathname.includes('\\'))
    return null;
  return `https://${url.hostname}${url.pathname}`;
}

export function isOnAppHost(raw: string, record: Pick<AppPostIntentRecord, 'host'>) {
  const url = parseHttpsUrl(raw);
  return !!url && url.hostname === record.host;
}

/** The approval record whose host and prefix contain `manifestUrl`, or null. */
export function matchAppRecord<T extends Pick<AppPostIntentRecord, 'host' | 'pathPrefix'>>(
  manifestUrl: string,
  records: T[]
): T | null {
  return (
    records
      .filter((r) => isUnderAppPrefix(manifestUrl, r))
      .sort((a, b) => b.pathPrefix.length - a.pathPrefix.length)[0] ?? null
  );
}

export const postIntentManifestSchema = z.object({
  app: z.string().min(1),
  media: z
    .array(z.object({ url: z.string(), type: z.enum(['image', 'video']).optional() }))
    .min(1)
    .max(POST_INTENT_MAX_MEDIA),
  title: z.string().max(255).optional(),
  description: z.string().max(10_000).optional(),
  tags: z.array(z.string().max(50)).max(POST_TAG_LIMIT).optional(),
  link: z.string().optional(),
  returnUrl: z.string().optional(),
  details: z
    .record(z.string().max(100), z.union([z.string().max(500), z.number(), z.boolean()]))
    .refine((d) => Object.keys(d).length <= DETAILS_LIMIT, `at most ${DETAILS_LIMIT} details`)
    .optional(),
  expiresAt: z.iso.datetime({ offset: true }).optional(),
  // A bad item key falls back to the app's own credit rather than refusing the share.
  item: z.string().regex(APP_SUB_LISTING_EXTERNAL_ID_RE).optional().catch(undefined),
});
export type PostIntentManifest = z.infer<typeof postIntentManifestSchema>;

/**
 * Validate a fetched manifest against the approval record for the host that served it.
 * The app id comes from the record; the manifest's own `app` field only has to agree.
 */
export function checkManifest(
  json: unknown,
  record: AppPostIntentRecord,
  now: Date
): PostIntentManifest {
  const parsed = postIntentManifestSchema.safeParse(json);
  if (!parsed.success) throw new PostIntentRefusal('bad-manifest', 'The share link is not valid.');
  const manifest = parsed.data;
  if (manifest.app !== record.appId)
    throw new PostIntentRefusal('app-mismatch', 'The share link does not belong to this app.');
  if (manifest.expiresAt && new Date(manifest.expiresAt).getTime() <= now.getTime())
    throw new PostIntentRefusal('expired', 'This share link has expired.');
  if (!manifest.media.every((m) => isUnderAppPrefix(m.url, record)))
    throw new PostIntentRefusal('outside-prefix', 'The shared media is not hosted by this app.');
  for (const field of [manifest.link, manifest.returnUrl]) {
    if (field !== undefined && !isOnAppHost(field, record))
      throw new PostIntentRefusal('bad-manifest', 'The share link points away from this app.');
  }
  return manifest;
}

export type SniffedIntentMedia = { type: 'image' | 'video'; mimeType: string };

const IMAGE_MIME = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

export function sniffIntentMedia(bytes: Uint8Array): SniffedIntentMedia | null {
  const image = sniffImageFormat(bytes, {
    formats: ['jpeg', 'png', 'webp', 'gif'] as const,
    pngSignature: 'full',
    minLength: 12,
  });
  if (image) return { type: 'image', mimeType: IMAGE_MIME[image] };
  if (isoBrand(bytes) && !isHeifBrand(bytes)) return { type: 'video', mimeType: 'video/mp4' };
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  )
    return { type: 'video', mimeType: 'video/webm' };
  return null;
}

const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
  'avif',
  'avis',
]);

function isoBrand(bytes: Uint8Array): string | null {
  if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(4, 8)) !== 'ftyp') return null;
  return String.fromCharCode(...bytes.subarray(8, 12));
}

/** HEIC and AVIF stills share the MP4 container signature; they are images the site cannot take. */
export function isHeifBrand(bytes: Uint8Array) {
  const brand = isoBrand(bytes);
  return !!brand && HEIF_BRANDS.has(brand);
}

export function maxBytesFor(type: SniffedIntentMedia['type']) {
  return type === 'image' ? POST_INTENT_IMAGE_MAX_BYTES : POST_INTENT_VIDEO_MAX_BYTES;
}

export function buildIntentExternalMeta(
  manifest: PostIntentManifest,
  record: AppPostIntentRecord
): ExternalMetaSchema {
  return {
    source: { name: record.listingName, homepage: `https://${record.host}/` },
    ...(manifest.details ? { details: manifest.details } : {}),
    ...(manifest.link ? { createUrl: manifest.link } : {}),
  };
}
