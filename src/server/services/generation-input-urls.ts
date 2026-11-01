import { TRPCError } from '@trpc/server';
import { env as clientEnv } from '~/env/client';
import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { registerCounterWithLabels } from '~/server/prom/client';
import {
  CIVITAI_IMAGE_HOSTS,
  hasUrlAmbiguousBytes,
} from '~/server/schema/blocks/civitai-image-url';
import {
  assertClientKeysIssuedToCaller,
  imageUrlUnavailableError,
  keyIssuers,
  keysIn,
  MAX_KEYS,
} from '~/server/services/image-url-ownership';
import { isTrustedOrchestratorUrl } from '~/server/services/orchestrator/trusted-blob-url';
import { ORCHESTRATOR_PROXY_HOST } from '~/server/orchestrator/region-proxy';

export const GENERATION_IMAGE_UNAVAILABLE_MESSAGE =
  'One of the images for this generation is no longer available. Please choose or upload another.';

export const generationImageUnavailableError = () =>
  imageUrlUnavailableError(GENERATION_IMAGE_UNAVAILABLE_MESSAGE);

/** An upload key as minted: the whole value, nothing around it. */
const BARE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Stored urls a generation reads (a reference panel's image): refused if any image on them is blocked. */
export async function assertStoredImageUrlsUnblocked(urls: string[]) {
  const keys = [...new Set(urls.flatMap(keysIn))];
  if (!keys.length) return;
  const blocked = await dbWrite.$queryRaw<unknown[]>`
    SELECT 1 FROM "Image" WHERE url = ANY(${[
      ...keys,
      ...urls,
    ]}::text[]) AND "blockedFor" IS NOT NULL
    LIMIT 1
  `;
  if (blocked.length) throw generationImageUnavailableError();
}

type InputImageRow = { url: string; userId: number; visible: boolean; blocked: boolean };

/**
 * Each key must name the caller's own image, another user's publicly visible image, or, with no
 * image yet, a key issued to the caller. A blocked or removed image is refused whoever owns it.
 * `urls` are the values the keys came from, matched too for images stored under a full url.
 * `imagesOnly`: a key with no image passes unless it was issued to someone else (an unrecorded uuid
 * may be another service's id).
 */
async function assertKeysUsable({
  keys,
  urls,
  userId,
  now,
  imagesOnly = false,
}: {
  keys: string[];
  urls: string[];
  userId: number;
  now?: Date;
  imagesOnly?: boolean;
}) {
  if (!keys.length) return;
  if (keys.length > MAX_KEYS) throw generationImageUnavailableError();

  const rows = await dbWrite.$queryRaw<InputImageRow[]>`
    SELECT i.url, i."userId",
      (i."blockedFor" IS NOT NULL OR i."tosViolation" OR p."tosViolation" IS TRUE) AS blocked,
      (i.ingestion = 'Scanned' AND i."blockedFor" IS NULL AND i."needsReview" IS NULL
        AND NOT i."tosViolation" AND p."publishedAt" <= now()
        AND p.availability IN ('Public', 'Unsearchable') AND NOT p."tosViolation") IS TRUE AS visible
    FROM "Image" i
    LEFT JOIN "Post" p ON p.id = i."postId"
    WHERE i.url = ANY(${[...new Set([...keys, ...urls])]}::text[])
  `;
  if (rows.some((r) => r.blocked)) throw generationImageUnavailableError();

  const rowsByKey = new Map(
    keys.map((key) => [key, rows.filter((r) => r.url === key || keysIn(r.url).includes(key))])
  );
  for (const keyRows of rowsByKey.values()) {
    if (!keyRows.length || keyRows.some((r) => r.userId === userId)) continue;
    if (!keyRows.every((r) => r.visible)) throw generationImageUnavailableError();
  }

  const unrowed = keys.filter((key) => !rowsByKey.get(key)?.length);
  if (!unrowed.length) return;
  if (imagesOnly) {
    // Only an issue record to someone else marks it as ours; an unrecorded uuid may be anyone's id.
    const issuers = await keyIssuers({ urls: unrowed, userId });
    const unreadable = issuers.recordReadFailed && issuers.requestLogReadFailed;
    if (issuers.tooMany || issuers.issuedToOthers.length || unreadable)
      throw generationImageUnavailableError();
    return;
  }
  try {
    await assertClientKeysIssuedToCaller({ urls: unrowed, userId, now });
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'BAD_REQUEST')
      throw generationImageUnavailableError();
    throw error;
  }
}

/**
 * Client-supplied urls a generation reads (an img2img source, reference images). Each must be a
 * bare upload key, and each key must pass `assertKeysUsable`.
 */
export async function assertGenerationInputUrlsUsable({
  urls,
  userId,
  now,
}: {
  urls: (string | null | undefined)[];
  userId: number;
  now?: Date;
}) {
  const given = urls.filter((url): url is string => !!url);
  if (given.some((url) => !BARE_KEY.test(url))) throw generationImageUnavailableError();
  const keys = [...new Set(given)];
  await assertKeysUsable({ keys, urls: [], userId, now });
}

// #region [any generation input]
export type GenerationInputUrlClass =
  | 'orchestrator'
  | 'key'
  | 'cdn'
  | 'civitai_other'
  | 'external'
  | 'invalid';

export type GenerationInputEntryPoint =
  | 'generateFromGraph'
  | 'whatIfFromGraph'
  | 'iterateGenerate'
  | 'getIterateCostEstimate'
  | 'imageUpload'
  | 'appBlocks'
  | 'appBlocksStep'
  | 'appBlocksPassThrough'
  | 'appBlocksWorkflow'
  | 'enhancePrompt'
  | 'comicsCostEstimate'
  | 'comicPanelJob';

/** Entry points where an external host is only counted while the external-host flag is off. */
const EXTERNAL_COUNTED_ENTRIES = new Set<GenerationInputEntryPoint>([
  'generateFromGraph',
  'whatIfFromGraph',
  'appBlocksStep',
  'appBlocksPassThrough',
  'appBlocksWorkflow',
  'enhancePrompt',
]);

const IMAGE_CDN_HOSTS = CIVITAI_IMAGE_HOSTS.map((h) => `image.${h}`);

function imageCdnHosts() {
  try {
    const configured = new URL(clientEnv.NEXT_PUBLIC_IMAGE_LOCATION).host.toLowerCase();
    return [configured, ...IMAGE_CDN_HOSTS];
  } catch {
    return IMAGE_CDN_HOSTS;
  }
}

/** Whether any decoded form of `value` carries a url of its own (`scheme://`). */
const carriesUrl = (value: string) => {
  let current = value;
  for (let pass = 0; pass < 8; pass++) {
    if (current.includes('://')) return true;
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return true;
    }
    if (next === current) return false;
    current = next;
  }
  return true;
};

export function classifyGenerationInputUrl(raw: string): GenerationInputUrlClass {
  if (BARE_KEY.test(raw)) return 'key';
  if (hasUrlAmbiguousBytes(raw)) return 'invalid';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'invalid';
  }
  const host = parsed.host.toLowerCase();
  const isCdn = imageCdnHosts().includes(host);
  const configuredOrigin = (() => {
    try {
      return new URL(clientEnv.NEXT_PUBLIC_IMAGE_LOCATION).origin;
    } catch {
      return undefined;
    }
  })();
  // The configured image origin may be http on a local stack; every other url must be https.
  if (parsed.protocol !== 'https:' && !(isCdn && parsed.origin === configuredOrigin))
    return 'invalid';
  if (parsed.username || parsed.password) return 'invalid';

  // The region proxy is a transparent route to the orchestrator: same blobs, same rule.
  if (isTrustedOrchestratorUrl(raw) || host === ORCHESTRATOR_PROXY_HOST)
    return carriesUrl(parsed.pathname + parsed.search + parsed.hash)
      ? 'civitai_other'
      : 'orchestrator';
  if (isCdn) return 'cdn';
  const hostname = parsed.hostname.toLowerCase();
  if (CIVITAI_IMAGE_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`)))
    return 'civitai_other';
  return 'external';
}

const refusalCounter = registerCounterWithLabels({
  name: 'generation_input_url_refusals_total',
  help:
    'Generation input urls refused, or (mode=log) that would be refused, labelled by entry point, ' +
    'url class and caller type.',
  labelNames: ['entry', 'class', 'caller', 'mode'] as const,
});

/** Schemes a fetcher may resolve. `urn:` (AIR ids) is not one of them. */
const FETCH_SCHEMES = new Set([
  'http:',
  'https:',
  'data:',
  'blob:',
  'ftp:',
  'file:',
  'ws:',
  'wss:',
]);

/** Graph fields that hold free text, never a url read by a handler. */
const FREE_TEXT_FIELDS = new Set([
  'prompt',
  'negativePrompt',
  'musicDescription',
  'lyrics',
  'description',
  'title',
  'texturePrompt',
  'yue2Abc',
  'name',
  'trainedWords',
]);

/** A free-text field's value: a string, or a list of strings (trained words). */
const isText = (item: unknown) =>
  typeof item === 'string' || (Array.isArray(item) && item.every((x) => typeof x === 'string'));

/** Anything that may be a key in another spelling: uuid hex with or without dashes or braces. */
const KEY_LIKE = /^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$/i;

/** A `KEY_LIKE` value as minted: lowercase, dashed, no braces. */
function canonicalKey(value: string) {
  const hex = value.replace(/[{}-]/g, '').toLowerCase();
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

function parsedProtocol(value: string) {
  try {
    return new URL(value.trim()).protocol;
  } catch {
    return undefined;
  }
}

/**
 * Whether `value` may name something to fetch: it parses to a fetch scheme, holds `://` or starts
 * with `//`, is key-shaped, or carries an upload key in an http(s) or scheme-less value (`keysIn`
 * finds none behind another scheme, so an AIR urn is not collected).
 */
function isFetchableValue(value: string) {
  const protocol = parsedProtocol(value);
  if (protocol && FETCH_SCHEMES.has(protocol)) return true;
  const trimmed = value.trim();
  return (
    KEY_LIKE.test(trimmed) ||
    trimmed.startsWith('//') ||
    value.includes('://') ||
    keysIn(value).length > 0
  );
}

/**
 * Every string in `value` that may name something to fetch (`isFetchableValue`), at any depth,
 * except the free-text fields (a prompt that mentions a url is not an input image).
 */
export function generationInputUrlsIn(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 32 || value == null) return out;
  if (typeof value === 'string') {
    if (isFetchableValue(value)) out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) generationInputUrlsIn(item, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    for (const [field, item] of Object.entries(value as Record<string, unknown>))
      if (!(FREE_TEXT_FIELDS.has(field) && isText(item)))
        generationInputUrlsIn(item, out, depth + 1);
  }
  return out;
}

/** Deeper than any orchestrator input a block may send; past it, `opaqueInputUrlsIn` gives up. */
const OPAQUE_INPUT_MAX_DEPTH = 64;

/** A scheme-less url: a dotted host, then a path. */
const SCHEMELESS_URL = /^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*$/i;

/**
 * Whether `value` is itself something to fetch, not text that mentions one: a url with a fetch
 * scheme, a `//` url, a key, or a scheme-less url carrying a key.
 */
function isWholeFetchableValue(value: string) {
  const trimmed = value.trim();
  const protocol = parsedProtocol(trimmed);
  if (protocol) return FETCH_SCHEMES.has(protocol);
  if (KEY_LIKE.test(trimmed) || trimmed.startsWith('//')) return true;
  return SCHEMELESS_URL.test(trimmed) && keysIn(trimmed).length > 0;
}

/**
 * Every whole url or key in an orchestrator-native input, under any field name (a field name
 * says nothing there: any step can `$ref` any field). `tooDeep` when the input nests past the
 * walk's bound, so a caller can refuse rather than pass what it did not read.
 */
export function opaqueInputUrlsIn(value: unknown) {
  const urls: string[] = [];
  let tooDeep = false;
  const walk = (item: unknown, depth: number) => {
    if (item == null || tooDeep) return;
    if (depth > OPAQUE_INPUT_MAX_DEPTH) {
      tooDeep = true;
      return;
    }
    if (typeof item === 'string') {
      if (isWholeFetchableValue(item)) urls.push(item);
    } else if (Array.isArray(item)) {
      for (const child of item) walk(child, depth + 1);
    } else if (typeof item === 'object') {
      for (const child of Object.values(item as Record<string, unknown>)) walk(child, depth + 1);
    }
  };
  walk(value, 0);
  return { urls, tooDeep };
}

/**
 * The one gate on a url a generation reads. Orchestrator blobs pass. A bare key or an image CDN
 * url passes only if every key it carries passes `assertKeysUsable`; a CDN url with no key is
 * refused. Other civitai hosts, non-https and unparseable values are refused. External hosts are
 * refused, except on `EXTERNAL_COUNTED_ENTRIES` while the external-host flag is off, where they
 * are only counted.
 */
export async function assertGenerationInputsUsable({
  urls,
  userId,
  entry,
  isApiCaller,
  opaqueInput = false,
  now,
}: {
  urls: (string | null | undefined)[];
  userId: number;
  entry: GenerationInputEntryPoint;
  isApiCaller: boolean;
  /**
   * Urls from an orchestrator-native input (`opaqueInputUrlsIn`), where a uuid may be any id and
   * an http url may be a schema id: a key-shaped value is refused only when it names an image
   * that fails, and http to an external host counts as external.
   */
  opaqueInput?: boolean;
  now?: Date;
}) {
  const given = [...new Set(urls.filter((url): url is string => !!url))];
  if (!given.length) return;
  const caller = isApiCaller ? 'api' : 'session';
  const refuse = (cls: GenerationInputUrlClass) => {
    refusalCounter.inc({ entry, class: cls, caller, mode: 'refuse' });
    return generationImageUnavailableError();
  };

  const keys = new Set<string>();
  const keyedUrls: string[] = [];
  // Keys found inside allowed external urls: refused only when they name an image that fails.
  const externalKeys = new Set<string>();
  for (const url of given) {
    if (opaqueInput && KEY_LIKE.test(url.trim())) {
      externalKeys.add(canonicalKey(url.trim()));
      continue;
    }
    let cls = classifyGenerationInputUrl(url);
    if (opaqueInput && cls === 'invalid' && /^http:/i.test(url.trim())) {
      const asHttps = classifyGenerationInputUrl(url.trim().replace(/^http:/i, 'https:'));
      if (asHttps === 'external') cls = 'external';
    }
    if (cls === 'orchestrator') continue;
    if (cls === 'key') {
      keys.add(url);
      continue;
    }
    if (cls === 'cdn') {
      const found = keysIn(url);
      if (!found.length) throw refuse(cls);
      found.forEach((key) => keys.add(key));
      keyedUrls.push(url);
      continue;
    }
    if (cls === 'external' && EXTERNAL_COUNTED_ENTRIES.has(entry)) {
      if (await isFlipt(FLIPT_FEATURE_FLAGS.GENERATION_INPUT_REFUSE_EXTERNAL_HOSTS))
        throw refuse(cls);
      refusalCounter.inc({ entry, class: cls, caller, mode: 'log' });
      // A proxy or wrapper url may carry one of our image keys.
      keysIn(url).forEach((key) => externalKeys.add(key));
      continue;
    }
    throw refuse(cls);
  }

  try {
    await assertKeysUsable({ keys: [...keys], urls: keyedUrls, userId, now });
    const imageOnlyKeys = [...externalKeys].filter((key) => !keys.has(key));
    await assertKeysUsable({ keys: imageOnlyKeys, urls: [], userId, now, imagesOnly: true });
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'BAD_REQUEST')
      refusalCounter.inc({ entry, class: 'key', caller, mode: 'refuse' });
    throw error;
  }
}
// #endregion
