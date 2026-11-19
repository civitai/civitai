import { sql } from '@civitai/db/kysely';
import { env } from '$env/dynamic/private';
import { heldImageSql } from '@civitai/shared/held-media';
import { reportListedUrlSql } from '@civitai/shared/held-url';
import {
  retractedImageWhereSql,
  retractedSuspectSql,
  retractedTier,
} from '@civitai/shared/retracted-media-tier';
import { logToAxiom } from './axiom';
import { blockedForPatterns } from './blocked-for-patterns';
import { dbWrite } from './db';
import type { HeldMedia } from './held-media';
import { retractedMediaCdnLeg, type RetractedMedia } from './retracted-media';

/**
 * The covered view: a moderator without the CSAM page's grant may open held and blocked media too,
 * except reported bytes. Off unless `CSAM_VIEW_COVERED_ENABLED` is exactly 'true'.
 */
export const coveredViewEnabled = () => env.CSAM_VIEW_COVERED_ENABLED === 'true';

/** The answer for reported bytes, or when the read failed: the route answers as for a missing image. */
export const COVERED_REFUSED = 'covered-refused';

/** `null`: not eligible for the covered view, so the route answers as it does without it. */
type Covered<T> = T | typeof COVERED_REFUSED | null;

const isModeratorSql = (moderatorId: number) =>
  sql<boolean>`EXISTS (SELECT 1 FROM "User" mu WHERE mu.id = ${moderatorId} AND mu."isModerator" IS TRUE)`;
const listedSql = sql<boolean>`${sql.raw(reportListedUrlSql('i."url"'))}`;

type Trx = Parameters<Parameters<ReturnType<typeof dbWrite.transaction>['execute']>[0]>[0];

/** One read on the primary, so a report filed a moment ago is seen, under a 2s timeout. Any error,
 *  the timeout included, refuses. */
async function coveredRead<T extends { listed: boolean }>(
  imageId: number,
  moderatorId: number,
  read: (trx: Trx) => Promise<T | undefined>
): Promise<Covered<Omit<T, 'listed'>>> {
  try {
    const row = await dbWrite.transaction().execute(async (trx) => {
      await sql`SET LOCAL statement_timeout = '2s'`.execute(trx);
      return read(trx);
    });
    if (!row) return null;
    if (row.listed) {
      void logToAxiom({
        name: 'csam-view-covered-refused',
        type: 'info',
        payload: { imageId, moderatorId },
      });
      return COVERED_REFUSED;
    }
    const { listed: _, ...rest } = row;
    return rest;
  } catch (e) {
    void logToAxiom({
      name: 'csam-view-covered-read-failed',
      type: 'error',
      payload: { imageId, moderatorId, message: e instanceof Error ? e.message : String(e) },
    });
    return COVERED_REFUSED;
  }
}

/** Held media for a moderator on the covered view. */
export function getCoveredHeldMedia(imageId: number, moderatorId: number) {
  return coveredRead<HeldMedia & { listed: boolean }>(imageId, moderatorId, (trx) =>
    trx
      .selectFrom('Image as i')
      .select(['i.url', 'i.type', 'i.mimeType'])
      .select(listedSql.as('listed'))
      .where('i.id', '=', imageId)
      .where(sql<boolean>`${sql.raw(heldImageSql('i'))}`)
      // An evidence hold, a legal one included, is never on the covered view.
      .where(
        sql<boolean>`NOT EXISTS (SELECT 1 FROM "EvidenceHoldImage" rh WHERE rh."imageId" = i.id)`
      )
      .where(isModeratorSql(moderatorId))
      .executeTakeFirst()
  );
}

/** Blocked media for a moderator on the covered view, whatever its tier or scanner verdict. */
export async function getCoveredRetractedMedia(
  imageId: number,
  moderatorId: number
): Promise<Covered<RetractedMedia>> {
  const row = await coveredRead(imageId, moderatorId, (trx) =>
    trx
      .selectFrom('Image as i')
      .select(['i.url', 'i.type', 'i.mimeType', 'i.blockedFor'])
      .select(sql<boolean>`${sql.raw(retractedSuspectSql('i'))}`.as('suspect'))
      .select(listedSql.as('listed'))
      .where('i.id', '=', imageId)
      .where(
        sql<boolean>`${sql.raw(
          retractedImageWhereSql('i', { cdnLeg: retractedMediaCdnLeg(), covered: true })
        )}`
      )
      .where(isModeratorSql(moderatorId))
      .executeTakeFirst()
  );
  if (!row || row === COVERED_REFUSED) return row;
  return {
    url: row.url,
    type: row.type,
    mimeType: row.mimeType,
    tier: retractedTier(row, blockedForPatterns()),
  };
}
