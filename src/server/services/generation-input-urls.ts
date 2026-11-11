import { TRPCError } from '@trpc/server';
import { env as clientEnv } from '~/env/client';
import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { registerCounterWithLabels } from '~/server/prom/client';
import { externalHostBucket, recordExternalHost } from '~/server/services/generation-input-hosts';
import { logToAxiom } from '~/server/logging/client';
import {
  CIVITAI_IMAGE_HOSTS,
  hasUrlAmbiguousBytes,
} from '~/server/schema/blocks/civitai-image-url';
import {
  assertClientKeysIssuedToCaller,
  type DecodeBudget,
  imageUrlUnavailableError,
  keyIssuers,
  keysIn,
  keysInTextWithin,
  keysInWithin,
  MAX_KEYS,
} from '~/server/services/image-url-ownership';
import { isTrustedOrchestratorUrl } from '~/server/services/orchestrator/trusted-blob-url';
import { ORCHESTRATOR_PROXY_HOST } from '~/server/orchestrator/region-proxy';
import { INLINE_MEDIA_MAX_VISITS } from '~/server/schema/blocks/inline-media';
import { EXTERNAL_LINK_INTERSTITIAL_PATH } from '~/utils/external-link';

export const GENERATION_IMAGE_UNAVAILABLE_MESSAGE =
  'One of the images for this generation is no longer available. Please choose or upload another.';

export const generationImageUnavailableError = () =>
  imageUrlUnavailableError(GENERATION_IMAGE_UNAVAILABLE_MESSAGE);

/** Shown when a generation input links to a host outside Civitai, which the gate refuses. */
export const GENERATION_EXTERNAL_IMAGE_MESSAGE =
  'This request includes a link to an image hosted outside Civitai. Please upload the image instead.';

export const generationExternalImageError = () =>
  imageUrlUnavailableError(GENERATION_EXTERNAL_IMAGE_MESSAGE);

/** Shown when an orchestrator-native input carries a plain link to a Civitai page, refused there. */
export const GENERATION_PAGE_LINK_MESSAGE =
  'This request includes a link to a Civitai page, not an image. Please upload the image instead.';

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

type AppSourceRefusal = 'held' | 'unscannable' | 'pending' | 'unrowed' | 'store-unreadable';

type InputImageRow = {
  url: string;
  userId: number;
  visible: boolean;
  blocked: boolean;
  scanComplete: boolean;
  /** Not scanned yet, in a state the scan still moves on from. */
  scanPending: boolean;
  /** Held for review, or flagged minor or poi. */
  held: boolean;
};

/** Shown to an app whose generation input names an image the scan has not finished. */
export const APP_SOURCE_PENDING_MESSAGE =
  'that image is still being scanned — wait for it to finish before using it';
/** Shown to an app whose generation input names an image it may not generate from. */
export const APP_SOURCE_UNUSABLE_MESSAGE =
  'that image can’t be used as a generation source — choose a different image';
/** Shown to an app whose generation input is not an image stored on Civitai. */
export const APP_SOURCE_NOT_ON_CIVITAI_MESSAGE =
  'generation inputs from apps must be images uploaded or published on Civitai';

const appSourcePendingError = () => imageUrlUnavailableError(APP_SOURCE_PENDING_MESSAGE);

/** True for the refusal of an app's own upload whose scan has not finished. */
export const isAppSourcePendingError = (error: unknown) =>
  error instanceof TRPCError && error.message === APP_SOURCE_PENDING_MESSAGE;
const appSourceUnusableError = () => imageUrlUnavailableError(APP_SOURCE_UNUSABLE_MESSAGE);
const appSourceNotOnCivitaiError = () =>
  imageUrlUnavailableError(APP_SOURCE_NOT_ON_CIVITAI_MESSAGE);

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
  maxKeys = MAX_KEYS,
  appBlock,
}: {
  keys: string[];
  urls: string[];
  userId: number;
  now?: Date;
  /**
   * Every image, the caller's own included, must be scanned and unflagged; see
   * `APP_BLOCK_ENTRIES`. Told the reason before each such refusal.
   */
  appBlock?: { refusing: (reason: AppSourceRefusal) => void };
  imagesOnly?: boolean;
  /** Most keys one check reads; the image lookup still goes `MAX_KEYS` at a time. */
  maxKeys?: number;
}) {
  if (!keys.length) return;
  if (keys.length > maxKeys) throw generationImageUnavailableError();

  const lookup = [...new Set([...keys, ...urls])];
  const rows: InputImageRow[] = [];
  for (let i = 0; i < lookup.length; i += MAX_KEYS)
    rows.push(
      ...(await dbWrite.$queryRaw<InputImageRow[]>`
        SELECT i.url, i."userId",
          (i."blockedFor" IS NOT NULL OR i."tosViolation" OR p."tosViolation" IS TRUE) AS blocked,
          (i.ingestion = 'Scanned' AND i."blockedFor" IS NULL AND i."needsReview" IS NULL
            AND NOT i."tosViolation" AND p."publishedAt" <= now()
            AND p.availability IN ('Public', 'Unsearchable') AND NOT p."tosViolation") IS TRUE AS visible,
          (i.ingestion = 'Scanned') AS "scanComplete",
          (i.ingestion IN ('Pending', 'Rescan', 'PendingManualAssignment')) AS "scanPending",
          (i."needsReview" IS NOT NULL OR i.minor IS TRUE OR i.poi IS TRUE) AS held
        FROM "Image" i
        LEFT JOIN "Post" p ON p.id = i."postId"
        WHERE i.url = ANY(${lookup.slice(i, i + MAX_KEYS)}::text[])
      `)
    );
  if (rows.some((r) => r.blocked)) throw generationImageUnavailableError();

  // One pass over the rows (`keysIn` once each), not keys × rows.
  const rowsByKey = new Map(keys.map((key): [string, InputImageRow[]] => [key, []]));
  for (const row of rows)
    for (const key of new Set([row.url, ...keysIn(row.url)])) rowsByKey.get(key)?.push(row);
  for (const keyRows of rowsByKey.values()) {
    const own = keyRows.some((r) => r.userId === userId);
    if (appBlock && keyRows.some((r) => r.held || !r.scanComplete)) {
      // Only the owner learns why: to anyone else the image is just unavailable.
      if (!own) throw generationImageUnavailableError();
      if (keyRows.some((r) => r.held)) {
        appBlock.refusing('held');
        throw appSourceUnusableError();
      }
      if (keyRows.some((r) => !r.scanComplete && !r.scanPending)) {
        appBlock.refusing('unscannable');
        throw appSourceUnusableError();
      }
      appBlock.refusing('pending');
      throw appSourcePendingError();
    }
    if (!keyRows.length || own) continue;
    if (!keyRows.every((r) => r.visible)) throw generationImageUnavailableError();
  }

  const unrowed = keys.filter((key) => !rowsByKey.get(key)?.length);
  if (!unrowed.length) return;
  if (imagesOnly) {
    // Only an issue record to someone else marks it as ours; an unrecorded uuid may be anyone's id.
    // One issue-record and request-log read over every unrowed key.
    const issuers = await keyIssuers({ urls: unrowed, userId, maxKeys });
    if (issuers.tooMany || issuers.issuedToOthers.length) throw generationImageUnavailableError();
    // With either store unreadable, an app's unscanned upload could pass as an opaque key.
    if (appBlock && (issuers.recordReadFailed || issuers.requestLogReadFailed)) {
      appBlock.refusing('store-unreadable');
      throw appSourceUnusableError();
    }
    if (issuers.recordReadFailed && issuers.requestLogReadFailed)
      throw generationImageUnavailableError();
    // A key issued to the caller with no row is an upload that never reached the scan.
    const unrecorded = new Set(issuers.unrecorded);
    if (appBlock && unrowed.flatMap(keysIn).some((key) => !unrecorded.has(key))) {
      appBlock.refusing('unrowed');
      throw appSourceUnusableError();
    }
    return;
  }
  try {
    await assertClientKeysIssuedToCaller({ urls: unrowed, userId, now });
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'BAD_REQUEST')
      throw generationImageUnavailableError();
    throw error;
  }
  if (appBlock) {
    appBlock.refusing('unrowed');
    throw appSourceUnusableError();
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
  | 'appBlocksInlineComfy'
  | 'enhancePrompt'
  | 'comicsCostEstimate'
  | 'comicPanelJob'
  | 'remixAppRun'
  | 'remixAppQuote'
  | 'articleReframe';

/** App Blocks entries: their sources must be scanned, unflagged images stored on Civitai. */
const APP_BLOCK_ENTRIES = new Set<GenerationInputEntryPoint>([
  'appBlocks',
  'appBlocksStep',
  'appBlocksPassThrough',
  'appBlocksWorkflow',
  'appBlocksInlineComfy',
]);

/** Entry points where an external host is only counted while the external-host flag is off. */
const EXTERNAL_COUNTED_ENTRIES = new Set<GenerationInputEntryPoint>([
  'generateFromGraph',
  'whatIfFromGraph',
  'appBlocksStep',
  'appBlocksPassThrough',
  'appBlocksWorkflow',
  'appBlocksInlineComfy',
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

/** A url's host, lower-cased; a fully-qualified host (`image.civitai.com.`) is the same server. */
const normalisedHost = (parsed: URL) => parsed.host.toLowerCase().replace(/\.(?=(:\d+)?$)/, '');

export function classifyGenerationInputUrl(raw: string): GenerationInputUrlClass {
  if (BARE_KEY.test(raw)) return 'key';
  if (hasUrlAmbiguousBytes(raw)) return 'invalid';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'invalid';
  }
  const host = normalisedHost(parsed);
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
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
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

/**
 * Orchestrator sources on App Blocks entries, counted only: nothing is refused on this count.
 * `host-orchestrator-source` is a consumer-blob path; `host-unparsable` is any other orchestrator
 * path, such as a job output.
 */
const appBlockHostSourceCounter = registerCounterWithLabels({
  name: 'app_block_host_source_total',
  help: 'Orchestrator-hosted generation sources on App Blocks entries, by entry point and reason.',
  labelNames: ['entry', 'reason'] as const,
});

/** An App Blocks source check runs on the estimate and again on the submit of the same run. */
export type GenerationInputPhase = 'estimate' | 'submit';

type AppBlockHostSourceReason = 'host-orchestrator-source' | 'host-unparsable';

const CONSUMER_BLOB_PATH = /\/v\d+\/consumer\/blobs\/[^/]+$/i;

function appBlockHostSourceReason(url: string): AppBlockHostSourceReason {
  try {
    return CONSUMER_BLOB_PATH.test(new URL(url).pathname)
      ? 'host-orchestrator-source'
      : 'host-unparsable';
  } catch {
    return 'host-unparsable';
  }
}

type AppBlockLog = { appBlockId?: string; stepTypes?: string; phase?: GenerationInputPhase };

/** One Axiom row per reason with its count, so a many-image step is one row, not one per url. */
function recordAppBlockHostSources(
  entry: GenerationInputEntryPoint,
  reasons: AppBlockHostSourceReason[],
  appBlockLog: AppBlockLog | undefined
) {
  const counts = new Map<AppBlockHostSourceReason, number>();
  for (const reason of reasons) {
    appBlockHostSourceCounter.inc({ entry, reason });
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  for (const [reason, count] of counts)
    void logToAxiom({
      name: 'app-block-host-source',
      type: 'info',
      entry,
      reason,
      count,
      appBlockId: appBlockLog?.appBlockId,
      stepTypes: appBlockLog?.stepTypes,
      phase: appBlockLog?.phase,
    }).catch(() => undefined);
}

/**
 * Counts the orchestrator-hosted sources of an App Blocks text-to-image body, whose own gate runs
 * inside the step builder, after the token and once per built step. Call it once per estimate
 * and once per submit, before the token. A source the scanned-rows flag refuses is not counted.
 */
export async function countAppBlockHostSources({
  urls,
  appBlockLog,
}: {
  urls: (string | null | undefined)[];
  appBlockLog: AppBlockLog;
}) {
  const reasons = [...new Set(urls.filter((url): url is string => !!url))]
    .filter((url) => classifyGenerationInputUrl(url) === 'orchestrator')
    .map(appBlockHostSourceReason);
  if (!reasons.length) return;
  if (await isFlipt(FLIPT_FEATURE_FLAGS.APP_BLOCK_SOURCE_SCANNED_ROWS)) return;
  recordAppBlockHostSources('appBlocks', reasons, appBlockLog);
}

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

/** A scheme as a url parser reads it: leading C0 and space skipped, tab, CR and LF dropped. */
// eslint-disable-next-line no-control-regex
const SCHEME_LED = /^[\x00-\x20]*([a-z][a-z0-9+.\t\r\n-]*):/i;

/** `new URL(value.trim()).protocol`, or undefined where that throws, without building the URL. */
function parsedProtocol(value: string) {
  const trimmed = value.trim();
  const scheme = SCHEME_LED.exec(trimmed)?.[1];
  if (!scheme || !URL.canParse(trimmed)) return undefined;
  return `${scheme.replace(/[\t\r\n]/g, '').toLowerCase()}:`;
}

const SPECIAL_SCHEMES = new Set(['http', 'https', 'ws', 'wss', 'ftp', 'file']);

/**
 * The host of a special-scheme `value` as a url parser takes it (up to the first `/ ? # \`), or
 * undefined. A parser converts such a host to ASCII, at a cost of about its length squared.
 */
function specialHostIn(value: string) {
  const trimmed = value.trim();
  const match = SCHEME_LED.exec(trimmed);
  if (!match || !SPECIAL_SCHEMES.has(match[1].replace(/[\t\r\n]/g, '').toLowerCase()))
    return undefined;
  const rest = trimmed.slice(match[0].length).replace(/^[/\\\t\r\n]*/, '');
  const end = rest.search(/[/?#\\]/);
  return end === -1 ? rest : rest.slice(0, end);
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

/** `value` as a WHATWG url parser reads it: C0 controls and spaces trimmed, tab/LF/CR removed. */
const asUrlParserReads = (value: string) => {
  // A scan from each end, not an unanchored `[…]+$` regex, which is quadratic on long runs.
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
  return value.slice(start, end).replace(/[\t\n\r]/g, '');
};

/**
 * Whether a later line of `value` starts like a url of its own (`scheme:` or `//`): then the
 * lines are separate values, as a consumer splitting them would fetch them, not one url broken
 * by a newline (which a url parser would rejoin).
 */
function splitsIntoUrlLines(value: string) {
  const lines = value
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return false;
  const urlLed = (line: string) => /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(line);
  // A url then prose is two values too; a url wrapped onto a second line with no spaces is one.
  return (
    lines.slice(1).some(urlLed) || (urlLed(lines[0]) && lines.slice(1).some((l) => l.includes(' ')))
  );
}

export const TOO_MANY_IDS_MESSAGE =
  'This request carries too many ids to check. Send fewer ids in one request.';

/** Most image-only keys one check reads (rows `MAX_KEYS` at a time, issuers in one read). */
const IMAGE_ONLY_MAX_KEYS = 1024;
/** Image-only key sets larger than this are counted by size. */
const IMAGE_ONLY_KEY_SIZE_REPORTED = 256;

export const keySetSizeBucket = (size: number) =>
  size > IMAGE_ONLY_MAX_KEYS ? 'over_1024' : size > 512 ? '513_1024' : '257_512';

const largeKeySetCounter = registerCounterWithLabels({
  name: 'generation_input_large_key_sets_total',
  help: 'Generation inputs carrying more than 256 image-only keys, by entry point and size bucket.',
  labelNames: ['entry', 'size'] as const,
});

/**
 * What one walk reads before it gives up (`tooLarge`), so its cost stays bounded on an input with
 * no byte cap of its own (a registry step's `params`): values (an object entry is two), string
 * characters, line breaks, characters of `%XX`-decoded forms, url parses, and values collected
 * (count and total length).
 * 4 MiB of text is above the largest `params` a step schema accepts (a chat completion's messages
 * and tool calls).
 */
const OPAQUE_INPUT_MAX_VISITS = INLINE_MEDIA_MAX_VISITS;
const OPAQUE_INPUT_MAX_CHARS = 4 * 1024 * 1024;
/** Line breaks (a run of CR and LF is one) across every string. */
const OPAQUE_INPUT_MAX_LINES = 65_536;

/** Runs of CR and LF in `value`, counted without splitting it. */
function lineBreaksIn(value: string) {
  let breaks = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if ((c === 10 || c === 13) && i > 0) {
      const prev = value.charCodeAt(i - 1);
      if (prev !== 10 && prev !== 13) breaks++;
    }
  }
  return breaks;
}
const OPAQUE_INPUT_MAX_DECODED_CHARS = 1024 * 1024;
const OPAQUE_INPUT_MAX_URLS = 4096;
const OPAQUE_INPUT_MAX_URL_CHARS = 64 * 1024;
/** Strings that start like a url, each parsed as one. */
const OPAQUE_INPUT_MAX_PARSES = 32_768;
/**
 * Work a parser does converting hosts to ASCII (those holding non-ASCII, `%` escapes or `xn--`),
 * charged as the conversion costs plus a fixed cost per parse: the host as a parser maps it
 * (NFKC expands some characters), its length times its distinct characters, or its length squared
 * when escapes or `xn--` hide what it decodes to. An ASCII host costs nothing.
 */
const OPAQUE_INPUT_MAX_IDNA_COST = 32 * 1024 * 1024;
const IDNA_PARSE_COST = 8192;
function idnaCostOf(host: string) {
  // Past this, mapping it would cost the most of all; no message holds a run that long.
  if (host.length > 64 * 1024) return OPAQUE_INPUT_MAX_IDNA_COST + 1;
  // A run of combining marks is reordered, by the mapping below and by a parser, in its length
  // squared: charged first, so an over-budget run is refused before it is mapped. A parser
  // deletes ignorable characters first, rejoining a run they split, and two halfwidth katakana
  // marks map to combining marks.
  let marks = 0;
  const visible = host.replace(/\p{Default_Ignorable_Code_Point}/gu, '');
  for (const [run] of visible.matchAll(/[\p{M}\uFF9E\uFF9F]+/gu)) marks += run.length * run.length;
  if (marks > OPAQUE_INPUT_MAX_IDNA_COST) return marks;
  const mapped = host.normalize('NFKC');
  const work = /%[0-9a-f]{2}|xn--/i.test(mapped)
    ? mapped.length * mapped.length
    : mapped.length * new Set(mapped).size;
  return marks + work + IDNA_PARSE_COST;
}
// eslint-disable-next-line no-control-regex
const IDNA_HOST = /[^\x00-\x7f]|%|xn--/i;

/** Deeper than any orchestrator input a block may send; past it, `opaqueInputUrlsIn` gives up. */
const OPAQUE_INPUT_MAX_DEPTH = 64;

/** Whether a host is one of ours, any subdomain, a trailing dot ignored. */
function isCivitaiHostname(host: string) {
  const name = host.toLowerCase().replace(/\.$/, '');
  return CIVITAI_IMAGE_HOSTS.some((h) => name === h || name.endsWith(`.${h}`));
}

/**
 * A link to one of our pages (`https://civitai.com/models/1`) that names no upload key and
 * carries no url of its own: it reads what any anonymous visitor reads, so it is not an image
 * input to guard.
 */
function isPlainPageLink(url: string) {
  if (keysIn(url).length) return false;
  try {
    const { pathname, search, hash } = new URL(url);
    // The external-link interstitial shows its target; it never fetches or redirects.
    if (pathname === EXTERNAL_LINK_INTERSTITIAL_PATH) return true;
    return !carriesUrl(pathname + search + hash);
  } catch {
    return false;
  }
}

/** A scheme-less url: a dotted host, then a path. */
const SCHEMELESS_URL = /^[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*$/i;

/**
 * Whether a trimmed `value` is itself something to fetch, not text that mentions one: exactly an
 * http(s) url (no whitespace or control bytes inside, which a url parser would silently drop), or
 * a scheme-less url on one of our hosts carrying a key.
 */
function isWholeFetchableValue(value: string, budget: DecodeBudget, protocol: string | undefined) {
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return false;
  if (protocol) return protocol === 'https:' || protocol === 'http:';
  return (
    SCHEMELESS_URL.test(value) &&
    isCivitaiHostname(value.split('/')[0]) &&
    keysInWithin(value, budget).length > 0
  );
}

/**
 * Free text a registry step declares in its params (`freeTextParamPaths`), each `list[].field`:
 * the string `field` of every item of the array `list` at the top of the params. Or
 * `list[].field.**`: everything under `field` of every item is text, whatever its shape (every
 * string in it, object keys included).
 */
export type FreeTextPaths = readonly string[];

/** `'string'`: a string at the field is text. `'subtree'`: everything under the field is. */
type FreeTextKind = 'string' | 'subtree';

/** `paths` as list name -> the item fields that are free text, and how. */
function freeTextFieldsByList(paths: FreeTextPaths = []) {
  const byList = new Map<string, Map<string, FreeTextKind>>();
  for (const path of paths) {
    const [list, spec] = path.split('[].');
    const subtree = spec.endsWith('.**');
    const fields = byList.get(list) ?? new Map<string, FreeTextKind>();
    fields.set(subtree ? spec.slice(0, -3) : spec, subtree ? 'subtree' : 'string');
    byList.set(list, fields);
  }
  return byList;
}

/** Whether a url names one of our images: on our image CDN or a civitai host, carrying a key. */
function namesOurImage(url: string, budget: DecodeBudget) {
  try {
    const parsed = new URL(url);
    if (!imageCdnHosts().includes(normalisedHost(parsed)) && !isCivitaiHostname(parsed.hostname))
      return false;
  } catch {
    return false;
  }
  return keysInWithin(url, budget).length > 0;
}

/**
 * What an orchestrator-native input may fetch, under any field name (a field name says nothing
 * there: any step can `$ref` any field). A string that is a url is collected whole (trimmed). Any
 * other string is text, which a consumer may still split into urls, so every upload key in it is
 * collected bare, in any spelling `keysIn` reads: the gate's `opaqueInput` mode refuses those
 * only when they name an image that fails. `tooDeep` when the input nests past the walk's bound,
 * so a caller can refuse rather than pass what it did not read.
 *
 * `freeTextPaths`: strings at these paths are free text, never a url to fetch, so a url in one is
 * not collected whole unless it names one of our images; its keys are collected as in any text.
 * Only a value that IS a string there is text (and a list only when it is an array): anything
 * else at the path is walked as usual. Under a `.**` path every string is text, whatever the shape.
 * Default none: every string is read as above.
 */
export function opaqueInputUrlsIn(value: unknown, freeTextPaths?: FreeTextPaths) {
  const textFieldsByList = freeTextFieldsByList(freeTextPaths);
  // Not `walkJsonValues`: this walk splits strings into lines and budgets depth and characters too.
  const urls: string[] = [];
  let tooDeep = false;
  let tooLarge = false;
  let visits = 0;
  let chars = 0;
  let lines = 0;
  const decoded: DecodeBudget = { left: OPAQUE_INPUT_MAX_DECODED_CHARS };
  let urlChars = 0;
  let parses = 0;
  let idnaCost = 0;
  // The gate decodes every distinct collected value again, so their total length is bounded too.
  const seen = new Set<string>();
  const collect = (url: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    urlChars += url.length;
    if (urls.length >= OPAQUE_INPUT_MAX_URLS || urlChars > OPAQUE_INPUT_MAX_URL_CHARS)
      tooLarge = true;
    else urls.push(url);
  };
  const pushKeysInText = (text: string) => {
    for (const key of keysInTextWithin(text, decoded)) collect(key);
    if (decoded.left < 0) tooLarge = true;
  };
  /**
   * `counted`: a line of a string whose characters were already counted whole. `text`: the string
   * is declared free text, or the array/object is under a declared `.**` field (so every string
   * in it, keys included, is text). `scope.list`: the item is a declared list, and these fields
   * of each of its items are text; `scope.item`: the item is one of those items.
   */
  const walk = (
    item: unknown,
    depth: number,
    counted = false,
    text = false,
    scope?: { list: Map<string, FreeTextKind> } | { item: Map<string, FreeTextKind> }
  ) => {
    if (item == null || tooDeep || tooLarge) return;
    if (depth > OPAQUE_INPUT_MAX_DEPTH) {
      tooDeep = true;
      return;
    }
    if (++visits > OPAQUE_INPUT_MAX_VISITS) {
      tooLarge = true;
      return;
    }
    if (typeof item === 'string') {
      if (!counted) chars += item.length;
      if (chars > OPAQUE_INPUT_MAX_CHARS) {
        tooLarge = true;
        return;
      }
      // Lines that are values of their own are read one by one, and the keys of the whole
      // string as a url parser rejoins it too: a key broken across a line is found that way.
      // The rejoined string is not a url to check whole (two listed links would glue into one).
      lines += lineBreaksIn(item);
      if (lines > OPAQUE_INPUT_MAX_LINES) {
        tooLarge = true;
        return;
      }
      if (splitsIntoUrlLines(item)) {
        for (const line of item.split(/[\r\n]+/)) walk(line, depth + 1, true, text);
        pushKeysInText(item);
        return;
      }
      // Unicode spaces too: a consumer trims them (str.strip, Trim) though WHATWG does not.
      const parsed = asUrlParserReads(item).trim();
      // eslint-disable-next-line no-control-regex
      const controlInside = /[\u0000-\u001f\u007f]/.test(parsed);
      if (SCHEME_LED.test(parsed) && ++parses > OPAQUE_INPUT_MAX_PARSES) {
        tooLarge = true;
        return;
      }
      const host = specialHostIn(parsed);
      if (
        host !== undefined &&
        IDNA_HOST.test(host) &&
        (idnaCost += idnaCostOf(host)) > OPAQUE_INPUT_MAX_IDNA_COST
      ) {
        tooLarge = true;
        return;
      }
      const protocol = parsedProtocol(parsed);
      if (text) {
        // Free text: only a url naming one of our images is collected whole; every key is still
        // collected so a private image is refused.
        if (
          !controlInside &&
          isWholeFetchableValue(parsed, decoded, protocol) &&
          (!protocol || namesOurImage(parsed, decoded))
        )
          collect(parsed);
        pushKeysInText(item);
      }
      // A url with a control byte left inside: hand it whole to the classifier, which refuses it.
      else if (controlInside && (protocol === 'https:' || protocol === 'http:')) collect(parsed);
      else if (isWholeFetchableValue(parsed, decoded, protocol)) {
        collect(parsed);
        // A url rejoined across a break or space: a consumer splitting on it reads the keys.
        if (/[^\x21-\x7e]/.test(item)) pushKeysInText(item);
      } else pushKeysInText(item);
      if (decoded.left < 0) tooLarge = true;
    } else if (Array.isArray(item)) {
      const fields = scope && 'list' in scope ? scope.list : undefined;
      for (const child of item)
        walk(child, depth + 1, false, text, fields ? { item: fields } : undefined);
    } else if (typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const itemFields = scope && 'item' in scope ? scope.item : undefined;
      for (const field of Object.keys(record)) {
        if (tooDeep || tooLarge) return;
        walk(field, depth + 1, false, text);
        const value = record[field];
        const listFields = depth === 0 ? textFieldsByList.get(field) : undefined;
        const kind = itemFields?.get(field);
        if (listFields && Array.isArray(value))
          walk(value, depth + 1, false, false, { list: listFields });
        else
          walk(
            value,
            depth + 1,
            false,
            text || kind === 'subtree' || (kind === 'string' && typeof value === 'string')
          );
      }
    }
  };
  walk(value, 0);
  return { urls, tooDeep, tooLarge };
}

/**
 * The one gate on a url a generation reads. Orchestrator blobs pass. A bare key or an image CDN
 * url passes only if every key it carries passes `assertKeysUsable`; a CDN url with no key is
 * refused. Other civitai hosts, non-https and unparseable values are refused. External hosts are
 * refused (with `GENERATION_EXTERNAL_IMAGE_MESSAGE`), except on `EXTERNAL_COUNTED_ENTRIES` while
 * the external-host flag is off, where they are only counted.
 */
export async function assertGenerationInputsUsable({
  urls,
  userId,
  entry,
  isApiCaller,
  opaqueInput = false,
  appBlockLog,
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
  /** Who and what an App Blocks entry's source log lines are about. Never a url or image id. */
  appBlockLog?: AppBlockLog;
  now?: Date;
}) {
  const given = [...new Set(urls.filter((url): url is string => !!url))];
  if (!given.length) return;
  const caller = isApiCaller ? 'api' : 'session';
  /** `pageLink`: a plain link to one of our pages, counted as `external` (`isPlainPageLink`). */
  const refuse = (cls: GenerationInputUrlClass, pageLink = false) => {
    refusalCounter.inc({ entry, class: cls, caller, mode: 'refuse' });
    if (pageLink) return imageUrlUnavailableError(GENERATION_PAGE_LINK_MESSAGE);
    return cls === 'external' ? generationExternalImageError() : generationImageUnavailableError();
  };

  const keys = new Set<string>();
  const keyedUrls: string[] = [];
  // Keys found inside allowed external urls: refused only when they name an image that fails.
  const externalKeys = new Set<string>();
  // Read once per call, only when an external url is seen.
  let refuseExternal: boolean | undefined;
  const appBlock = APP_BLOCK_ENTRIES.has(entry);
  const logAppSource = (
    reason: AppSourceRefusal | 'external',
    extra: Record<string, unknown> = {}
  ) =>
    void logToAxiom({
      name: 'app-block-source-refusal',
      type: 'info',
      entry,
      reason,
      appBlockId: appBlockLog?.appBlockId,
      stepTypes: appBlockLog?.stepTypes,
      phase: appBlockLog?.phase,
      ...extra,
    }).catch(() => undefined);
  const appBlockKeys = appBlock
    ? { refusing: (reason: AppSourceRefusal) => logAppSource(reason) }
    : undefined;
  let refuseExternalAppSource: boolean | undefined;
  const loggedHosts = new Set<string>();
  let refuseOrchestrator: boolean | undefined;
  // Recorded only once the whole call passes, so a refused call counts nothing.
  const hostSources: AppBlockHostSourceReason[] = [];
  for (const url of given) {
    if (opaqueInput && KEY_LIKE.test(url.trim())) {
      externalKeys.add(canonicalKey(url.trim()));
      continue;
    }
    let cls = classifyGenerationInputUrl(url);
    let pageLink = false;
    if (opaqueInput) {
      const asHttps =
        cls === 'invalid' && /^http:/i.test(url)
          ? classifyGenerationInputUrl(url.replace(/^http:/i, 'https:'))
          : cls;
      pageLink = asHttps === 'civitai_other' && isPlainPageLink(url);
      if (asHttps === 'external' || pageLink) cls = 'external';
    }
    if (cls === 'orchestrator') {
      if (appBlock) {
        // Turns on with scanned source rows: until then an app's uploaded source is a blob.
        refuseOrchestrator ??= await isFlipt(FLIPT_FEATURE_FLAGS.APP_BLOCK_SOURCE_SCANNED_ROWS);
        if (refuseOrchestrator) {
          refusalCounter.inc({ entry, class: cls, caller, mode: 'refuse' });
          throw appSourceNotOnCivitaiError();
        }
        // `appBlocks` gates inside its step builder; its router counts with countAppBlockHostSources.
        if (entry !== 'appBlocks') hostSources.push(appBlockHostSourceReason(url));
      }
      continue;
    }
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
      refuseExternal ??= await isFlipt(FLIPT_FEATURE_FLAGS.GENERATION_INPUT_REFUSE_EXTERNAL_HOSTS);
      if (appBlock && !refuseExternal)
        refuseExternalAppSource ??= await isFlipt(
          FLIPT_FEATURE_FLAGS.APP_BLOCK_REFUSE_EXTERNAL_SOURCES
        );
      const refuseHere = refuseExternal || refuseExternalAppSource === true;
      recordExternalHost({
        url,
        entry,
        caller,
        mode: refuseHere ? 'refuse' : 'log',
        userId,
      });
      if (appBlock) {
        const host = externalHostBucket(url);
        if (!loggedHosts.has(host)) {
          loggedHosts.add(host);
          logAppSource('external', { host, mode: refuseHere ? 'refuse' : 'log' });
        }
      }
      if (refuseHere) throw refuse(cls, pageLink);
      refusalCounter.inc({ entry, class: cls, caller, mode: 'log' });
      // A proxy or wrapper url may carry one of our image keys.
      keysIn(url).forEach((key) => externalKeys.add(key));
      continue;
    }
    throw refuse(cls, pageLink);
  }

  try {
    await assertKeysUsable({
      keys: [...keys],
      urls: keyedUrls,
      userId,
      now,
      appBlock: appBlockKeys,
    });
    const imageOnlyKeys = [...externalKeys].filter((key) => !keys.has(key));
    if (imageOnlyKeys.length > IMAGE_ONLY_KEY_SIZE_REPORTED)
      largeKeySetCounter.inc({ entry, size: keySetSizeBucket(imageOnlyKeys.length) });
    // Text can carry many unrelated uuids (message and tool call ids). Past the bound a check
    // would cost too much; an unchecked remainder could be padded around, so it is refused.
    if (imageOnlyKeys.length > IMAGE_ONLY_MAX_KEYS)
      throw new TRPCError({ code: 'BAD_REQUEST', message: TOO_MANY_IDS_MESSAGE });
    await assertKeysUsable({
      keys: imageOnlyKeys,
      urls: [],
      userId,
      now,
      imagesOnly: true,
      maxKeys: IMAGE_ONLY_MAX_KEYS,
      appBlock: appBlockKeys,
    });
    if (hostSources.length) recordAppBlockHostSources(entry, hostSources, appBlockLog);
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'BAD_REQUEST')
      refusalCounter.inc({ entry, class: 'key', caller, mode: 'refuse' });
    throw error;
  }
}
// #endregion
