import { Prisma } from '@prisma/client';
import { allBrowsingLevelsFlag, getHighestBrowsingLevelBit } from '@civitai/shared';
import { isTextScanRaised } from '@civitai/shared/rated-entity-sql';
import { NsfwLevel } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { ratedEntityContentNsfwLevelSql } from '~/server/services/text-scan/scan-floor';
import { BOUNTY_SCAN_DETAILS_KEY } from '~/server/utils/bounty-details';

// Blocked is a ToS action, not a rating: an `nsfw` bounty stores R|X|XXX|Blocked, so its highest bit would read as Blocked.
export const ratedLevel = (mask: number) =>
  getHighestBrowsingLevelBit(mask & allBrowsingLevelsFlag);

/**
 * The level a text scan's moderation row rated a bounty at, or null when that verdict did not set
 * its nsfw flag. The scan sets the flag only at R or above, so a later verdict below R leaves the
 * flag set without naming a level.
 */
export function scanFlagLevel(scan: { nsfwLevel: number | null; result: unknown }) {
  if (!isTextScanRaised({ entityType: 'Bounty', ...scan })) return null;
  const scanned = ratedLevel(scan.nsfwLevel ?? 0);
  return scanned >= NsfwLevel.R ? scanned : null;
}

export const withContentLevel = (scanned: number, content: number | null) =>
  Math.max(scanned, ratedLevel(content ?? 0));

/**
 * The rating fields a write that newly sets a bounty's nsfw flag also sets, or undefined. A rating
 * below R is older than the flag and would outrank it, so it is raised to R, never cleared: cleared,
 * the bounty would fall below it once the flag is turned off again. No basis, so the rating review
 * cannot auto-lower it; a moderator must.
 */
export function staleRatingRaise(
  stored: { nsfw: boolean; moderatorNsfwLevel: number | null },
  nsfw: boolean | undefined
) {
  if (nsfw !== true || stored.nsfw || stored.moderatorNsfwLevel == null) return undefined;
  if (ratedLevel(stored.moderatorNsfwLevel) >= NsfwLevel.R) return undefined;
  return { moderatorNsfwLevel: NsfwLevel.R, moderatorNsfwLevelBasis: null };
}

type BountyLevelInput = { nsfw: boolean; nsfwLevel: number; moderatorNsfwLevel: number | null };

/** Bounties whose nsfw flag may carry a text rating: the ones to pass to getTextRatedBountyLevels. */
export const mayBeTextRated = (b: BountyLevelInput) => b.nsfw && b.moderatorNsfwLevel == null;

/**
 * The level each nsfw-flagged bounty was rated at when the text scan set its flag: the scan's
 * verdict, raised to its images' level. A bounty with no such rating is absent.
 * The details marker says the scan set the flag; the level comes from the scan's moderation row.
 */
export async function getTextRatedBountyLevels(ids: number[]): Promise<Map<number, number>> {
  const levels = new Map<number, number>();
  if (!ids.length) return levels;
  const rows = await dbRead.$queryRaw<
    {
      id: number;
      byScan: boolean;
      scanCurrent: boolean;
      scanLevel: number | null;
      scanVersion: string | null;
      content: number | null;
    }[]
  >`
    SELECT b.id,
      (b.details -> ${BOUNTY_SCAN_DETAILS_KEY}::text) IS NOT NULL AS "byScan",
      sm.status = 'Succeeded'::"EntityModerationStatus" AS "scanCurrent",
      sm."nsfwLevel" AS "scanLevel",
      sm.result ->> 'version' AS "scanVersion",
      ${ratedEntityContentNsfwLevelSql('Bounty', 'b')} AS content
    FROM "Bounty" b
    LEFT JOIN "EntityModeration" sm ON sm."entityType" = 'Bounty' AND sm."entityId" = b.id
    WHERE b.id IN (${Prisma.join(ids)})
  `;
  for (const row of rows) {
    // A pending or failed rescan keeps the previous verdict on the row; only a settled one rates.
    if (!row.byScan || !row.scanCurrent) continue;
    const scanned = scanFlagLevel({
      nsfwLevel: row.scanLevel,
      result: { version: row.scanVersion },
    });
    if (scanned != null) levels.set(row.id, withContentLevel(scanned, row.content));
  }
  return levels;
}

/**
 * The single level a bounty is shown at, or null to keep its stored level. A moderator rating wins
 * in both directions; an nsfw flag with no recorded rating fails closed to XXX.
 */
export function bountyNsfwFlagLevel(b: BountyLevelInput, textRated: number | undefined) {
  if (!b.nsfw) return null;
  if (b.moderatorNsfwLevel != null) return ratedLevel(b.moderatorNsfwLevel) || NsfwLevel.XXX;
  return textRated ?? NsfwLevel.XXX;
}
