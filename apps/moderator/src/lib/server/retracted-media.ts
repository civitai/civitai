import { sql } from '@civitai/db/kysely';
import { env } from '$env/dynamic/private';
import {
  RETRACTED_MEDIA_READ_TIMEOUT_MS,
  RETRACTED_SERVED_ACTIVITY,
} from '@civitai/shared/retracted-media';
import { heldImageKnownSql } from '@civitai/shared/held-media';
import { blockedForSignal, type ScannerVerdict } from '@civitai/shared/media-signals';
import {
  createScannerVerdictCache,
  retractedAccessColumnsSql,
  retractedImageWhereSql,
  moderatorMediaWhereSql,
  retractedViewable,
  siblingsClearInPostgres,
  type UrlSibling,
} from '@civitai/shared/retracted-media-tier';
import { blockedForPatterns } from './blocked-for-patterns';
import { dbWrite } from './db';
import { holdsCsamReview } from './held-media';
import { APPEAL_RULING_REFUSED, SCANNER_UNAVAILABLE_REFUSED } from '$lib/held-media';
import { insertModActivity } from './mod-activity';
import { readScannerCsamVerdict, readScannerCsamVerdicts } from './review-batch';

export const scannerVerdicts = createScannerVerdictCache(readScannerCsamVerdict);

export type RetractedMedia = {
  url: string;
  type: string;
  mimeType: string | null;
};

/** `held` marks held media (`heldImageSql`), so its serve is recorded as a held view; who is served
 *  it is `moderatorMediaWhereSql`'s call. */
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
  const { viewable: open } = await viewableToNonGrant(rows, readVerdicts);
  for (const row of rows) if (open.has(row.id)) viewable.set(row.id, media(row));
  return { eligible, viewable };
}

type AccessRow = ScannerRow & {
  blockedFor: string | null;
  restricted: boolean;
  siblings: UrlSibling[];
};

/**
 * Which of `rows` a moderator without `csamReview` may see: the one decision behind
 * `readRetractedMedia` and `restrictedImageIds`. A row Postgres refuses (`restricted`, a `blockedFor`
 * signal) is not read from the scanner; the rest go to `retractedViewable`, with `readVerdicts` for
 * the rows and one scanner read for their url siblings. A verdict that could not be read refuses.
 */
async function viewableToNonGrant(
  rows: AccessRow[],
  readVerdicts: (rows: ScannerRow[]) => Promise<Map<number, ScannerVerdict | null> | null>
): Promise<{ viewable: Set<number>; unreadable: Set<number> }> {
  const viewable = new Set<number>();
  const unreadable = new Set<number>();
  const patterns = blockedForPatterns();
  const candidates = rows.filter(
    (row) => !row.restricted && !blockedForSignal(row.blockedFor, patterns)
  );
  if (!candidates.length) return { viewable, unreadable };
  const siblingIds = [...new Set(candidates.flatMap((row) => row.siblings.map((s) => s.id)))];
  const [verdicts, siblingVerdicts] = await Promise.all([
    readVerdicts(candidates),
    readScannerCsamVerdicts(siblingIds),
  ]);
  for (const row of candidates) {
    const verdict = verdicts?.get(row.id) ?? null;
    const ok = await retractedViewable(row, {
      patterns,
      readVerdict: async () => verdict,
      readVerdicts: async () => siblingVerdicts,
    });
    if (ok) viewable.add(row.id);
    else if (verdict === null || (row.siblings.length && !siblingVerdicts)) unreadable.add(row.id);
  }
  return { viewable, unreadable };
}

/** Ids `restrictedImageIds` reads in one go, so a large selection is several bounded reads. */
const RESTRICTED_READ_PAGE = 200;

/**
 * Which of these images a moderator without `csamReview` is refused (`kept`), so a list withholds
 * what `/api/retracted-media` would refuse. Only rows that route could serve are read from the
 * scanner, so ordinary moderation never waits on ClickHouse; a row whose verdict can't be read is
 * kept and named in `unreadable`. An id the primary lacks is kept too.
 */
export async function restrictedImageAccess(
  imageIds: number[],
  { csamReview }: { csamReview: boolean }
): Promise<{ kept: Set<number>; unreadable: Set<number> }> {
  const kept = new Set<number>();
  const unreadable = new Set<number>();
  if (csamReview) return { kept, unreadable };
  const patterns = blockedForPatterns();
  const scanScope = `(${retractedImageWhereSql('i', {
    cdnLeg: retractedMediaCdnLeg(),
  })} OR ${heldImageKnownSql('i')})`;
  for (let i = 0; i < imageIds.length; i += RESTRICTED_READ_PAGE) {
    const page = imageIds.slice(i, i + RESTRICTED_READ_PAGE);
    const access = retractedAccessColumnsSql('i', { csamReview });
    const rows = await dbWrite.transaction().execute(async (trx) => {
      await sql
        .raw(`SET LOCAL statement_timeout = ${RETRACTED_MEDIA_READ_TIMEOUT_MS}`)
        .execute(trx);
      return trx
        .selectFrom((eb) =>
          eb.selectFrom('Image').selectAll().where('id', 'in', page).offset(0).as('i')
        )
        .select(['i.id', 'i.blockedFor', 'i.ingestion'])
        .select(sql<boolean>`${sql.raw(access.restricted)}`.as('restricted'))
        .select(sql<UrlSibling[]>`${sql.raw(access.siblings)}`.as('siblings'))
        .select(sql<boolean>`${sql.raw(scanScope)}`.as('scanned'))
        .execute();
    });
    const scanned = await viewableToNonGrant(
      rows.filter((row) => row.scanned),
      (candidates) => readScannerCsamVerdicts(candidates.map((row) => row.id))
    );
    for (const id of scanned.unreadable) unreadable.add(id);
    const viewable = new Set(scanned.viewable);
    const isSignal = (blockedFor: string | null) => blockedForSignal(blockedFor, patterns);
    for (const row of rows)
      if (
        !row.scanned &&
        !row.restricted &&
        !isSignal(row.blockedFor) &&
        siblingsClearInPostgres(row.siblings, isSignal)
      )
        viewable.add(row.id);
    for (const id of page) if (!viewable.has(id)) kept.add(id);
  }
  return { kept, unreadable };
}

/** What every list serves a withheld image with in place of these fields: none of the media, and
 *  nothing that says why it is withheld. */
export const withheldMedia = () => ({
  url: '',
  type: null,
  name: null,
  width: null,
  height: null,
  blockedFor: null,
  needsReview: null,
  prompt: null,
  negativePrompt: null,
  tosReason: null,
  minor: false,
  poi: false,
  modelRestricted: false,
  removedAt: null,
  moderatorUsername: null,
  reports: [] as never[],
  tags: [] as never[],
  restricted: true as const,
});

/** `restrictedImageAccess`'s kept ids. */
export async function restrictedImageIds(imageIds: number[], opts: { csamReview: boolean }) {
  return (await restrictedImageAccess(imageIds, opts)).kept;
}

/** The images among these withheld from `user` (`restrictedImageIds`). */
export async function withheldImageIds(user: App.Locals['user'] | undefined, imageIds: number[]) {
  return [...(await restrictedImageIds(imageIds, { csamReview: holdsCsamReview(user) }))];
}

/** The refusal for a batch with an image withheld from `user`, which acts on none of it; `null`
 *  when nothing in it is withheld. */
export async function withheldRefusal(user: App.Locals['user'] | undefined, imageIds: number[]) {
  const { kept, unreadable } = await restrictedImageAccess(imageIds, {
    csamReview: holdsCsamReview(user),
  });
  if (!kept.size) return null;
  const withheld = [...kept];
  if (withheld.some((id) => unreadable.has(id))) {
    console.error('[retracted-media] scanner unavailable; refused an image action', {
      count: withheld.length,
    });
    return `${SCANNER_UNAVAILABLE_REFUSED} Nothing was changed: ${withheld.join(', ')}.`;
  }
  return `${APPEAL_RULING_REFUSED} Nothing was changed: ${withheld.join(', ')}.`;
}

/** The most images of one account `withheldAccountRefusal` reads; an account with more is refused
 *  to a moderator without the grant rather than read in full. */
export const ACCOUNT_CHECK_CAP = 1000;

/** The refusal for an action on every image `userId` owns when any of them is withheld from `user`,
 *  or there are more than `ACCOUNT_CHECK_CAP` to check; `null` otherwise. */
export async function withheldAccountRefusal(user: App.Locals['user'] | undefined, userId: number) {
  if (holdsCsamReview(user)) return null;
  const rows = await dbWrite
    .selectFrom('Image')
    .select('id')
    .where('userId', '=', userId)
    .orderBy('id')
    .limit(ACCOUNT_CHECK_CAP + 1)
    .execute();
  if (rows.length > ACCOUNT_CHECK_CAP)
    return `${APPEAL_RULING_REFUSED} This account has too many images to check — nothing was changed.`;
  return withheldRefusal(
    user,
    rows.map((r) => r.id)
  );
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
