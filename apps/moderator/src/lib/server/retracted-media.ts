import { sql } from '@civitai/db/kysely';
import { env } from '$env/dynamic/private';
import {
  RETRACTED_MEDIA_READ_TIMEOUT_MS,
  RETRACTED_SERVED_ACTIVITY,
} from '@civitai/shared/retracted-media';
import { blockedForSignal, type ScannerVerdict } from '@civitai/shared/media-signals';
import {
  createScannerVerdictCache,
  retractedAccessColumnsSql,
  retractedImageWhereSql,
  moderatorMediaWhereSql,
  retractedViewable,
  type UrlSibling,
} from '@civitai/shared/retracted-media-tier';
import { blockedForPatterns } from './blocked-for-patterns';
import { dbWrite } from './db';
import { insertModActivity } from './mod-activity';
import { readScannerCsamVerdict, readScannerCsamVerdicts } from './review-batch';

export const scannerVerdicts = createScannerVerdictCache(readScannerCsamVerdict);

export type RetractedMedia = {
  url: string;
  type: string;
  mimeType: string | null;
};

/** Held media is `heldImageSql`'s, read here only with `orHeld`; see `moderatorMediaWhereSql` for who
 *  is served it. */
export type ModeratorMedia = RetractedMedia & { kind: 'retracted' | 'held' };

type ScannerRow = { id: number; ingestion: string };

/**
 * Which of these images `/api/retracted-media` serves at all (`eligible`) and, with each one's
 * storage key, which it serves to this moderator (`viewable`). A moderator without `csamReview` is
 * refused what `retractedViewable` refuses; `readVerdicts` reads the scanner for the rows Postgres has
 * not already refused. The same rules as the main app's `getRetractedMedia`, which has no held leg,
 * read on the primary for the same reason: a flag or hold the replica has not seen would otherwise
 * be missed. A read that fails throws.
 */
export async function readRetractedMedia(
  imageIds: number[],
  {
    csamReview,
    orHeld = false,
    readVerdicts,
  }: {
    csamReview: boolean;
    orHeld?: boolean;
    readVerdicts: (rows: ScannerRow[]) => Promise<Map<number, ScannerVerdict | null> | null>;
  }
): Promise<{ eligible: Set<number>; viewable: Map<number, ModeratorMedia> }> {
  const eligible = new Set<number>();
  const viewable = new Map<number, ModeratorMedia>();
  if (!imageIds.length) return { eligible, viewable };
  const access = retractedAccessColumnsSql('i', { csamReview });
  const cdnLeg = retractedMediaCdnLeg();
  const retracted = retractedImageWhereSql('i', { cdnLeg });
  const where = moderatorMediaWhereSql('i', { cdnLeg, csamReview, heldLeg: orHeld });
  const rows = await dbWrite.transaction().execute(async (trx) => {
    await sql.raw(`SET LOCAL statement_timeout = ${RETRACTED_MEDIA_READ_TIMEOUT_MS}`).execute(trx);
    return trx
      .selectFrom((eb) =>
        // OFFSET 0 keeps the id lookup a subquery, so the rest is read for these rows only.
        eb.selectFrom('Image').selectAll().where('id', 'in', imageIds).offset(0).as('i')
      )
      .select(['i.id', 'i.url', 'i.type', 'i.mimeType', 'i.blockedFor', 'i.ingestion'])
      .select(sql<boolean>`${sql.raw(retracted)}`.as('retracted'))
      .select(sql<boolean>`${sql.raw(access.restricted)}`.as('restricted'))
      .select(sql<UrlSibling[]>`${sql.raw(access.siblings)}`.as('siblings'))
      .where(sql<boolean>`${sql.raw(where)}`)
      .execute();
  });
  const media = (row: (typeof rows)[number]): ModeratorMedia => ({
    url: row.url,
    type: row.type,
    mimeType: row.mimeType,
    kind: row.retracted ? 'retracted' : 'held',
  });
  for (const row of rows) eligible.add(row.id);
  if (csamReview) {
    for (const row of rows) viewable.set(row.id, media(row));
    return { eligible, viewable };
  }
  const patterns = blockedForPatterns();
  const candidates = rows.filter(
    (row) => !row.restricted && !blockedForSignal(row.blockedFor, patterns)
  );
  if (!candidates.length) return { eligible, viewable };
  // The candidates' url siblings in one scanner read, not one read per row.
  const siblingIds = [...new Set(candidates.flatMap((row) => row.siblings.map((s) => s.id)))];
  const [verdicts, siblingVerdicts] = await Promise.all([
    readVerdicts(candidates),
    readScannerCsamVerdicts(siblingIds),
  ]);
  for (const row of candidates) {
    const ok = await retractedViewable(row, {
      patterns,
      readVerdict: async () => verdicts?.get(row.id) ?? null,
      readVerdicts: async () => siblingVerdicts,
    });
    if (ok) viewable.set(row.id, media(row));
  }
  return { eligible, viewable };
}

/** Each row's verdict, one read per row: a scanned image can be rescanned, so it is read fresh; a
 *  blocked one from the cache. For the single-image readers. */
const verdictOf = async (rows: ScannerRow[]) =>
  new Map(
    await Promise.all(
      rows.map(
        async (row) =>
          [
            row.id,
            row.ingestion === 'Scanned'
              ? await readScannerCsamVerdict(row.id)
              : await scannerVerdicts.read(row.id),
          ] as const
      )
    )
  );

/**
 * The image's storage key and type while this moderator may see it on `/api/retracted-media`, media
 * held for itself excluded; `null` otherwise, so an image they may not see is answered exactly as a
 * missing one.
 */
export async function getRetractedMedia(
  imageId: number,
  { csamReview }: { csamReview: boolean }
): Promise<RetractedMedia | null> {
  const { viewable } = await readRetractedMedia([imageId], { csamReview, readVerdicts: verdictOf });
  const media = viewable.get(imageId);
  return media ? { url: media.url, type: media.type, mimeType: media.mimeType } : null;
}

/** What `/api/retracted-media` serves this moderator: `getRetractedMedia`, or held media to one with
 *  the CSAM grant. */
export async function getModeratorMedia(
  imageId: number,
  { csamReview }: { csamReview: boolean }
): Promise<ModeratorMedia | null> {
  const { viewable } = await readRetractedMedia([imageId], {
    csamReview,
    orHeld: true,
    readVerdicts: verdictOf,
  });
  return viewable.get(imageId) ?? null;
}

/** Every response carrying bytes, ranges included. Throws when the row is not written, so the bytes
 *  are not sent without it. */
export function recordRetractedView(moderatorId: number, imageId: number) {
  return insertModActivity({
    userId: moderatorId,
    entityType: 'image',
    entityId: imageId,
    activity: RETRACTED_SERVED_ACTIVITY,
  });
}

/** `/api/retracted-media` answers 404 unless this is exactly 'true'. */
export const retractedMediaEnabled = () => env.RETRACTED_MEDIA_ENABLED === 'true';

/** Whether a scanned image whose url the image CDN refuses is eligible too. */
export const retractedMediaCdnLeg = () => env.RETRACTED_MEDIA_CDN_LEG === 'true';
