/**
 * Content levels (build 3), the MEDIA half of a shared document's rating: the civitai images a
 * document references, and the highest level among them. The rater takes the higher of this and
 * the text's level (`doc-rater.service.ts`).
 *
 * A reference is any image key (a public image CDN key, uuid-shaped) found anywhere in the
 * document's text: in a string value or an object key, whole or inside a url, percent-encoded or
 * written with escaped dashes (`keysInText`, the same reader the image-ownership checks use). A key
 * names an image when an `Image` row stores it as its `url`; any other uuid in the data names
 * nothing and adds no level. Private generation media cannot be in a shared document at all (the
 * shared write refuses it), so public images are the only media to resolve.
 *
 * Fails closed: an image that is not rated yet (no level, or its scan has not finished) leaves the
 * whole document unrated, so it stays hidden from other viewers until the next pass; a Blocked
 * image makes the document Blocked.
 */
import { NsfwLevel } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { keysInTextWithin } from '~/server/services/image-url-ownership';
import type { SharedDataLeaf } from '~/server/services/apps/shared-data-leaves';
import { getHighestBrowsingLevelBit } from '~/shared/constants/browsingLevel.constants';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

/**
 * Distinct image keys resolved per document. A document holds at most 64 KB, so this is generous;
 * past it the document is not rated (`too-many`), never rated on a subset.
 */
export const DOC_MEDIA_MAX_KEYS = 200;

/** Characters of percent-decoding spent per document while looking for keys. */
const DECODE_BUDGET_CHARS = 512_000;

export type DocMediaKeys = { keys: string[] } | { overflow: 'too-many' | 'decode-budget' };

/** Every image key in a document's text leaves, deduplicated, in first-seen order. */
export function docMediaKeys(leaves: readonly SharedDataLeaf[]): DocMediaKeys {
  const budget = { left: DECODE_BUDGET_CHARS };
  const keys = new Set<string>();
  for (const leaf of leaves) {
    for (const key of keysInTextWithin(leaf.raw, budget)) {
      keys.add(key);
      if (keys.size > DOC_MEDIA_MAX_KEYS) return { overflow: 'too-many' };
    }
    if (budget.left < 0) return { overflow: 'decode-budget' };
  }
  return { keys: [...keys] };
}

export type DocMediaLevel =
  /** The highest level among the referenced images; PG when there are none. */
  | { status: 'rated'; level: NsfwLevel }
  /** At least one referenced image has no rating yet. */
  | { status: 'pending' };

type ImageRow = { url: string; nsfwLevel: number; ingestion: ImageIngestionStatus };

/** The single level an image contributes, or null while it is not rated. */
export function imageLevel(row: Pick<ImageRow, 'nsfwLevel' | 'ingestion'>): NsfwLevel | null {
  if (row.ingestion === ImageIngestionStatus.Blocked) return NsfwLevel.Blocked;
  if (row.ingestion !== ImageIngestionStatus.Scanned) return null;
  const bit = getHighestBrowsingLevelBit(row.nsfwLevel);
  return bit === 0 ? null : (bit as NsfwLevel);
}

/** The level of the images `keys` name (see the module header). */
export async function resolveDocMediaLevel(keys: readonly string[]): Promise<DocMediaLevel> {
  if (keys.length === 0) return { status: 'rated', level: NsfwLevel.PG };
  const rows = await dbRead.image.findMany({
    where: { url: { in: [...keys] } },
    select: { url: true, nsfwLevel: true, ingestion: true },
  });
  let level: NsfwLevel = NsfwLevel.PG;
  for (const row of rows) {
    const own = imageLevel(row);
    if (own === null) return { status: 'pending' };
    if (own > level) level = own;
  }
  return { status: 'rated', level };
}
