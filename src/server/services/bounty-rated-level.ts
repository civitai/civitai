import { Prisma } from '@prisma/client';
import { allBrowsingLevelsFlag, getHighestBrowsingLevelBit } from '@civitai/shared';
import { isTextScanRaised } from '@civitai/shared/rated-entity-sql';
import { NsfwLevel } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { ratedEntityContentNsfwLevelSql } from '~/server/services/text-scan/scan-floor';
import { BOUNTY_SCAN_DETAILS_KEY } from '~/server/utils/bounty-details';

const ratedLevel = (mask: number) => getHighestBrowsingLevelBit(mask & allBrowsingLevelsFlag);

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
    if (!row.byScan || !row.scanCurrent || row.scanLevel == null) continue;
    const raised = isTextScanRaised({
      entityType: 'Bounty',
      nsfwLevel: row.scanLevel,
      result: { version: row.scanVersion },
    });
    const scanned = raised ? ratedLevel(row.scanLevel) : 0;
    // The scan flags a bounty at R or above; a later, lower verdict does not lift the flag.
    if (scanned >= NsfwLevel.R) levels.set(row.id, Math.max(scanned, ratedLevel(row.content ?? 0)));
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
