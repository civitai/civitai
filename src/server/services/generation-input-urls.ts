import { TRPCError } from '@trpc/server';
import { dbWrite } from '~/server/db/client';
import {
  assertClientKeysIssuedToCaller,
  imageUrlUnavailableError,
  keysIn,
  MAX_KEYS,
} from '~/server/services/image-url-ownership';

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
 * Client-supplied urls a generation reads (an img2img source, reference images). Each must be a
 * bare upload key, and each key must name the caller's own image, another user's publicly visible
 * image, or, with no image yet, a key issued to the caller. A blocked image is refused whoever owns it.
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
  if (!keys.length) return;
  if (keys.length > MAX_KEYS) throw generationImageUnavailableError();

  const rows = await dbWrite.$queryRaw<InputImageRow[]>`
    SELECT i.url, i."userId", i."blockedFor" IS NOT NULL AS blocked,
      (i.ingestion = 'Scanned' AND i."blockedFor" IS NULL AND i."needsReview" IS NULL
        AND NOT i."tosViolation" AND p."publishedAt" <= now()
        AND p.availability IN ('Public', 'Unsearchable') AND NOT p."tosViolation") IS TRUE AS visible
    FROM "Image" i
    LEFT JOIN "Post" p ON p.id = i."postId"
    WHERE i.url = ANY(${keys}::text[])
  `;
  if (rows.some((r) => r.blocked)) throw generationImageUnavailableError();

  const rowsByKey = new Map(keys.map((key) => [key, rows.filter((r) => r.url === key)]));
  for (const keyRows of rowsByKey.values()) {
    if (!keyRows.length || keyRows.some((r) => r.userId === userId)) continue;
    if (!keyRows.every((r) => r.visible)) throw generationImageUnavailableError();
  }

  const unrowed = keys.filter((key) => !rowsByKey.get(key)?.length);
  if (!unrowed.length) return;
  try {
    await assertClientKeysIssuedToCaller({ urls: unrowed, userId, now });
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'BAD_REQUEST')
      throw generationImageUnavailableError();
    throw error;
  }
}
