/**
 * Content levels (build 3), the MEDIA half of a shared document's rating: the civitai images a
 * document references, and the highest level among them. The rater takes the higher of this and
 * the text's level (`doc-rater.service.ts`).
 *
 * A reference is either:
 * - an image KEY (a public image CDN key, uuid-shaped) found anywhere in the document's text: in a
 *   string value or an object key, whole or inside a url, percent-encoded or written with escaped
 *   dashes (`keysInText`, the same reader the image-ownership checks use). A key names an image when
 *   an `Image` row stores it as its `url`;
 * - an image ID: a number (or a string of digits) stored under an object key that says it is one
 *   (`isImageIdKey`), alone or in an array. An id names the `Image` row with that id. A number
 *   anywhere else is never read as an id: a count or a seed would then name some unrelated image.
 * Private generation media cannot be in a shared document at all (the shared write refuses it), so
 * public images are the only media to resolve.
 *
 * Fails closed: an image that is not rated yet (no level, or its scan has not finished) leaves the
 * whole document unrated, so it stays hidden from other viewers until the next pass; a Blocked
 * image makes the document Blocked; an image carrying a moderation flag (under review, flagged
 * minor or POI, a ToS violation, hard-blocked: what the site's own image gate hides at every level)
 * leaves it pending too; and a reference that says it is an image but names no `Image` row is
 * treated as an image not rated yet: a key inside an image url (an `http(s)://` url on a civitai
 * image CDN host, `imageCdnHosts`), or an image id. A key anywhere else that names no row (an app's
 * own uuid ids, a link to another site) adds no level.
 */
import { NsfwLevel } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { imageCdnHosts } from '~/server/services/generation-input-urls';
import { decodedForms, keysInTextWithin } from '~/server/services/image-url-ownership';
import { getHighestBrowsingLevelBit } from '~/shared/constants/browsingLevel.constants';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

/**
 * Distinct image references (keys and ids together) resolved per document. A document holds at
 * most 64 KB, so this is generous; past it the document is not rated (`too-many`), never rated on a
 * subset.
 */
export const DOC_MEDIA_MAX_KEYS = 200;

/** Characters of percent-decoding spent per document while looking for keys. */
const DECODE_BUDGET_CHARS = 512_000;

export type DocMediaKeys =
  | {
      keys: string[];
      /** The keys inside an image url: one that names no `Image` row keeps the document pending. */
      urlKeys: string[];
      /** The image ids (`docImageIds`): one that names no `Image` row keeps the document pending. */
      ids: number[];
    }
  | { overflow: 'too-many' | 'decode-budget' };

/**
 * THE object keys whose values are read as image ids, compared lower-cased: the names the platform
 * and the App Blocks starters use for an image's id, camelCase and snake_case. Deliberately a short
 * explicit list, not a pattern: a key that merely contains "id" could hold anything.
 */
const IMAGE_ID_KEYS: ReadonlySet<string> = new Set([
  'imageid',
  'imageids',
  'image_id',
  'image_ids',
]);

/** Whether a value stored under the object key `key` is read as an image id. */
export function isImageIdKey(key: string): boolean {
  return IMAGE_ID_KEYS.has(key.toLowerCase());
}

/** The largest `Image.id` (a Postgres `integer`). */
const MAX_IMAGE_ID = 2_147_483_647;

/**
 * The image id a value under an image-id key holds: a positive integer, or a string of digits only
 * (no sign, space or decimal point) naming one. Anything else, or a number no `Image.id` can be,
 * is not an id.
 */
export function asImageId(value: unknown): number | null {
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^[0-9]{1,10}$/.test(value)) n = Number(value);
  else return null;
  return Number.isInteger(n) && n >= 1 && n <= MAX_IMAGE_ID ? n : null;
}

/**
 * Every image id in a document's `data` (see the module header), deduplicated, in first-seen order.
 * Walks the whole value iteratively, so nesting depth cannot exhaust the stack; its size is bounded
 * by the document's own (at most 64 KB). An array under an image-id key is read one level deep.
 */
export function docImageIds(data: unknown): number[] {
  const ids = new Set<number>();
  const stack: unknown[] = [data];
  while (stack.length) {
    const value = stack.pop();
    if (value === null || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) stack.push(value[i]);
      continue;
    }
    const entries = Object.entries(value);
    for (let i = entries.length - 1; i >= 0; i--) stack.push(entries[i][1]);
    for (const [key, member] of entries) {
      if (!isImageIdKey(key)) continue;
      for (const item of Array.isArray(member) ? member : [member]) {
        const id = asImageId(item);
        if (id !== null) ids.add(id);
      }
    }
  }
  return [...ids];
}

/** Every http(s) url in a text, up to the first character a url cannot hold unescaped. */
const URL_IN_TEXT = /https?:\/\/[^\s"'<>\\]+/gi;

/** Whether `url` is on a civitai image CDN host (`imageCdnHosts`, shared with generation inputs). */
function onImageHost(url: string, hosts: readonly string[]): boolean {
  try {
    return hosts.includes(new URL(url).host.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Every image reference of a document: the image keys in its texts (its string values and object
 * keys, or its whole stored JSON text when those cannot all be read), and the image ids in its
 * `data` (`docImageIds`), each deduplicated, in first-seen order.
 */
export function docMediaKeys(texts: readonly string[], data: unknown): DocMediaKeys {
  const ids = docImageIds(data);
  if (ids.length > DOC_MEDIA_MAX_KEYS) return { overflow: 'too-many' };
  const found = docKeysInTexts(texts, DOC_MEDIA_MAX_KEYS - ids.length);
  return 'overflow' in found ? found : { ...found, ids };
}

/** The image keys in `texts`; `too-many` past `max` distinct keys. */
function docKeysInTexts(
  texts: readonly string[],
  max: number
): { keys: string[]; urlKeys: string[] } | { overflow: 'too-many' | 'decode-budget' } {
  const budget = { left: DECODE_BUDGET_CHARS };
  const hosts = imageCdnHosts();
  const keys = new Set<string>();
  const urlKeys = new Set<string>();
  for (const text of texts) {
    for (const key of keysInTextWithin(text, budget)) {
      keys.add(key);
      if (keys.size > max) return { overflow: 'too-many' };
    }
    for (const form of decodedForms(text, budget)) {
      for (const [url] of form.matchAll(URL_IN_TEXT)) {
        if (!onImageHost(url, hosts)) continue;
        for (const key of keysInTextWithin(url, budget)) {
          urlKeys.add(key);
          keys.add(key);
        }
      }
    }
    if (keys.size > max) return { overflow: 'too-many' };
    if (budget.left < 0) return { overflow: 'decode-budget' };
  }
  return { keys: [...keys], urlKeys: [...urlKeys] };
}

export type DocMediaLevel =
  /** The highest level among the referenced images; PG when there are none. */
  | { status: 'rated'; level: NsfwLevel }
  /** At least one referenced image has no rating yet. */
  | { status: 'pending' };

type ImageRow = {
  id: number;
  url: string;
  nsfwLevel: number;
  ingestion: ImageIngestionStatus;
  needsReview: string | null;
  poi: boolean;
  minor: boolean;
  tosViolation: boolean;
  acceptableMinor: boolean;
  blockedFor: string | null;
};

/**
 * The single level an image contributes, or null while it cannot be rated. A moderation flag reads
 * as not rated, whatever the level: the same flags the site's image gate hides an image for
 * (`classifyGatedImageForViewer`), decided first, as there.
 */
export function imageLevel(row: Omit<ImageRow, 'id' | 'url'>): NsfwLevel | null {
  if (
    row.needsReview != null ||
    row.poi ||
    row.minor ||
    row.tosViolation ||
    row.acceptableMinor ||
    row.blockedFor != null
  )
    return null;
  if (row.ingestion === ImageIngestionStatus.Blocked) return NsfwLevel.Blocked;
  if (row.ingestion !== ImageIngestionStatus.Scanned) return null;
  const bit = getHighestBrowsingLevelBit(row.nsfwLevel);
  return bit === 0 ? null : (bit as NsfwLevel);
}

/** The level of the images `keys` and `ids` name, read in one query (see the module header). */
export async function resolveDocMediaLevel(
  keys: readonly string[],
  urlKeys: readonly string[],
  ids: readonly number[]
): Promise<DocMediaLevel> {
  if (keys.length === 0 && ids.length === 0) return { status: 'rated', level: NsfwLevel.PG };
  const rows = await dbRead.image.findMany({
    where: {
      OR: [
        ...(keys.length ? [{ url: { in: [...keys] } }] : []),
        ...(ids.length ? [{ id: { in: [...ids] } }] : []),
      ],
    },
    select: {
      id: true,
      url: true,
      nsfwLevel: true,
      ingestion: true,
      needsReview: true,
      poi: true,
      minor: true,
      tosViolation: true,
      acceptableMinor: true,
      blockedFor: true,
    },
  });
  const foundUrls = new Set(rows.map((r) => r.url));
  const foundIds = new Set(rows.map((r) => r.id));
  if (urlKeys.some((key) => !foundUrls.has(key))) return { status: 'pending' };
  if (ids.some((id) => !foundIds.has(id))) return { status: 'pending' };
  let level: NsfwLevel = NsfwLevel.PG;
  for (const row of rows) {
    const own = imageLevel(row);
    if (own === null) return { status: 'pending' };
    if (own > level) level = own;
  }
  return { status: 'rated', level };
}
