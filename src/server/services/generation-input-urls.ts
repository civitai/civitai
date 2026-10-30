import { dbWrite } from '~/server/db/client';
import {
  assertClientKeysIssuedToCaller,
  imageUrlUnavailableError,
  keysIn,
  MAX_KEYS,
} from '~/server/services/image-url-ownership';
import { getAppealExcludedIds } from '~/server/services/report.service';

type InputImageRow = {
  id: number;
  url: string;
  userId: number;
  visible: boolean;
  blocked: boolean;
};

/**
 * Client-supplied urls a generation reads (an img2img source, reference images). Each upload key
 * must name the caller's own image, another user's publicly visible image, or, with no image yet, a
 * key issued to the caller. An image moderation has restricted is refused whoever owns it.
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
  const keys = [...new Set(urls.flatMap(keysIn))];
  if (!keys.length) return;
  if (keys.length > MAX_KEYS) throw imageUrlUnavailableError();

  const given = urls.filter((url): url is string => !!url && keysIn(url).length > 0);
  const rows = await dbWrite.$queryRaw<InputImageRow[]>`
    SELECT i.id, i.url, i."userId",
      (i.ingestion = 'Scanned' AND i."blockedFor" IS NULL AND i."needsReview" IS NULL
        AND NOT i."tosViolation" AND p."publishedAt" <= now()
        AND p.availability IN ('Public', 'Unsearchable') AND NOT p."tosViolation") IS TRUE AS visible,
      (i."blockedFor" IS NOT NULL
        OR EXISTS (SELECT 1 FROM "EvidenceHoldImage" h WHERE h."imageId" = i.id)) AS blocked
    FROM "Image" i
    LEFT JOIN "Post" p ON p.id = i."postId"
    WHERE i.url = ANY(${[...keys, ...given]}::text[])
  `;

  if (rows.length) {
    const excluded = await getAppealExcludedIds({
      imageIds: rows.map((r) => r.id),
      userIds: [...new Set(rows.map((r) => r.userId))],
    });
    const refused = (r: InputImageRow) =>
      r.blocked || excluded.images.has(r.id) || excluded.users.has(r.userId);
    if (rows.some(refused)) throw imageUrlUnavailableError();
  }

  const rowsByKey = new Map(
    keys.map((key) => [key, rows.filter((r) => keysIn(r.url).includes(key))])
  );
  for (const keyRows of rowsByKey.values()) {
    if (!keyRows.length || keyRows.some((r) => r.userId === userId)) continue;
    if (!keyRows.every((r) => r.visible)) throw imageUrlUnavailableError();
  }

  const unrowed = keys.filter((key) => !rowsByKey.get(key)?.length);
  if (unrowed.length) await assertClientKeysIssuedToCaller({ urls: unrowed, userId, now });
}
