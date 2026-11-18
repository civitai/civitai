/**
 * Content levels (build 3), the MEDIA half of a shared document's rating: the civitai images a
 * document references, and the highest level among them. The rater takes the higher of this and
 * the text's level (`doc-rater.service.ts`).
 *
 * A reference is any image key (a public image CDN key, uuid-shaped) found anywhere in the
 * document's text: in a string value or an object key, whole or inside a url, percent-encoded or
 * written with escaped dashes (`keysInText`, the same reader the image-ownership checks use). A key
 * names an image when an `Image` row stores it as its `url`. Private generation media cannot be in
 * a shared document at all (the shared write refuses it), so public images are the only media to
 * resolve.
 *
 * Fails closed: an image that is not rated yet (no level, or its scan has not finished) leaves the
 * whole document unrated, so it stays hidden from other viewers until the next pass; a Blocked
 * image makes the document Blocked; an image carrying a moderation flag (under review, flagged
 * minor or POI, a ToS violation, hard-blocked: what the site's own image gate hides at every level)
 * leaves it pending too; and a key inside an image url (an `http(s)://` url on a civitai image CDN
 * host, `imageCdnHosts`) that names no `Image` row is treated as an image not rated yet. A key
 * anywhere else that names no row (an app's own uuid ids, a link to another site) adds no level.
 */
import { NsfwLevel } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { imageCdnHosts } from '~/server/services/generation-input-urls';
import { decodedForms, keysInTextWithin } from '~/server/services/image-url-ownership';
import { getHighestBrowsingLevelBit } from '~/shared/constants/browsingLevel.constants';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

/**
 * Distinct image keys resolved per document. A document holds at most 64 KB, so this is generous;
 * past it the document is not rated (`too-many`), never rated on a subset.
 */
export const DOC_MEDIA_MAX_KEYS = 200;

/** Characters of percent-decoding spent per document while looking for keys. */
const DECODE_BUDGET_CHARS = 512_000;

export type DocMediaKeys =
  | {
      keys: string[];
      /** The keys inside an image url: one that names no `Image` row keeps the document pending. */
      urlKeys: string[];
    }
  | { overflow: 'too-many' | 'decode-budget' };

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
 * Every image key in a document's texts (its string values and object keys, or its whole stored
 * JSON text when those cannot all be read), deduplicated, in first-seen order.
 */
export function docMediaKeys(texts: readonly string[]): DocMediaKeys {
  const budget = { left: DECODE_BUDGET_CHARS };
  const hosts = imageCdnHosts();
  const keys = new Set<string>();
  const urlKeys = new Set<string>();
  for (const text of texts) {
    for (const key of keysInTextWithin(text, budget)) {
      keys.add(key);
      if (keys.size > DOC_MEDIA_MAX_KEYS) return { overflow: 'too-many' };
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
    if (keys.size > DOC_MEDIA_MAX_KEYS) return { overflow: 'too-many' };
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
export function imageLevel(row: Omit<ImageRow, 'url'>): NsfwLevel | null {
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

/** The level of the images `keys` name (see the module header). */
export async function resolveDocMediaLevel(
  keys: readonly string[],
  urlKeys: readonly string[] = []
): Promise<DocMediaLevel> {
  if (keys.length === 0) return { status: 'rated', level: NsfwLevel.PG };
  const rows = await dbRead.image.findMany({
    where: { url: { in: [...keys] } },
    select: {
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
  const found = new Set(rows.map((r) => r.url));
  if (urlKeys.some((key) => !found.has(key))) return { status: 'pending' };
  let level: NsfwLevel = NsfwLevel.PG;
  for (const row of rows) {
    const own = imageLevel(row);
    if (own === null) return { status: 'pending' };
    if (own > level) level = own;
  }
  return { status: 'rated', level };
}
