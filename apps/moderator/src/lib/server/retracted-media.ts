import { sql } from '@civitai/db/kysely';
import { env } from '$env/dynamic/private';
import {
  RETRACTED_MEDIA_READ_TIMEOUT_MS,
  RETRACTED_SERVED_ACTIVITY,
} from '@civitai/shared/retracted-media';
import {
  moderatorMediaWhereSql,
  moderatorWithheldSql,
  retractedImageWhereSql,
} from '@civitai/shared/retracted-media-tier';
import { dbRead, dbWrite } from './db';
import { holdsCsamReview } from './held-media';
import { WITHHELD_REFUSED } from '$lib/held-media';
import { insertModActivity } from './mod-activity';
import { logToAxiom } from './axiom';
import type { AppealCoverImage, MinorHashMatchDetail } from './minor-hash.service';
import type { ModelPreview } from './model-preview.service';
import type { ComFace } from '$lib/com-face';

/** `kind: 'held'` marks held media (`heldImageSql`), so its serve is recorded as a held view; who is served
 *  it is `moderatorMediaWhereSql`'s call. */
export type ModeratorMedia = {
  url: string;
  type: string;
  mimeType: string | null;
  kind: 'retracted' | 'held';
};

/**
 * Which of these images `/api/retracted-media` serves at all (`eligible`) and, with each one's
 * storage key, which it serves to this moderator (`viewable`): all of them with `csamReview`, else
 * those `moderatorWithheldSql` does not withhold. The same rule as the main app's
 * `getRetractedMedia`, which has no held leg, read on the primary so a flag or report the replica
 * has not seen still counts. A read that fails throws. Call it only for a moderator viewer.
 */
export async function readRetractedMedia(
  imageIds: number[],
  { csamReview, orHeld = false }: { csamReview: boolean; orHeld?: boolean }
): Promise<{ eligible: Set<number>; viewable: Map<number, ModeratorMedia> }> {
  const eligible = new Set<number>();
  const viewable = new Map<number, ModeratorMedia>();
  if (!imageIds.length) return { eligible, viewable };
  const cdnLeg = retractedMediaCdnLeg();
  const retracted = retractedImageWhereSql('i', { cdnLeg });
  const where = moderatorMediaWhereSql('i', { cdnLeg, csamReview, heldLeg: orHeld });
  const withheld = moderatorWithheldSql('i', { csamReview });
  const rows = await dbWrite.transaction().execute(async (trx) => {
    await sql.raw(`SET LOCAL statement_timeout = ${RETRACTED_MEDIA_READ_TIMEOUT_MS}`).execute(trx);
    return trx
      .selectFrom((eb) =>
        // OFFSET 0 keeps the id lookup a subquery, so the rest is read for these rows only.
        eb.selectFrom('Image').selectAll().where('id', 'in', imageIds).offset(0).as('i')
      )
      .select(['i.id', 'i.url', 'i.type', 'i.mimeType'])
      .select(sql<boolean>`${sql.raw(retracted)}`.as('retracted'))
      .select(sql<boolean>`${sql.raw(withheld)}`.as('withheld'))
      .where(sql<boolean>`${sql.raw(where)}`)
      .execute();
  });
  for (const row of rows) {
    eligible.add(row.id);
    if (!row.withheld)
      viewable.set(row.id, {
        url: row.url,
        type: row.type,
        mimeType: row.mimeType,
        kind: row.retracted ? 'retracted' : 'held',
      });
  }
  return { eligible, viewable };
}

/** Ids `restrictedImageAccess` reads in one go, so a large selection is several bounded reads. */
const RESTRICTED_READ_PAGE = 50;

/**
 * The moderator view's rule: call it only for a moderator viewer, never for anyone else.
 * Which of these images a moderator without `csamReview` is refused (`kept`,
 * `moderatorWithheldSql`), so a list withholds what `/api/retracted-media` would refuse. An id the
 * primary lacks is kept too, and named in `missing`.
 */
export async function restrictedImageAccess(
  imageIds: number[],
  { csamReview }: { csamReview: boolean }
): Promise<{ kept: Set<number>; missing: Set<number> }> {
  const kept = new Set<number>();
  const missing = new Set<number>();
  if (csamReview) return { kept, missing };
  const withheld = moderatorWithheldSql('i', { csamReview });
  for (let i = 0; i < imageIds.length; i += RESTRICTED_READ_PAGE) {
    const page = imageIds.slice(i, i + RESTRICTED_READ_PAGE);
    const rows = await dbWrite.transaction().execute(async (trx) => {
      await sql
        .raw(`SET LOCAL statement_timeout = ${RETRACTED_MEDIA_READ_TIMEOUT_MS}`)
        .execute(trx);
      return trx
        .selectFrom((eb) =>
          eb.selectFrom('Image').selectAll().where('id', 'in', page).offset(0).as('i')
        )
        .select('i.id')
        .select(sql<boolean>`${sql.raw(withheld)}`.as('withheld'))
        .execute();
    });
    const open = new Set(rows.filter((row) => !row.withheld).map((row) => row.id));
    const found = new Set(rows.map((row) => row.id));
    for (const id of page) {
      if (!open.has(id)) kept.add(id);
      if (!found.has(id)) missing.add(id);
    }
  }
  return { kept, missing };
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

/** An approved-appeal badge on a withheld row, without the removal label it names. */
export const withheldApprovedAppeal = <A extends { removalLabel: string | null } | null>(
  appeal: A
) => appeal && { ...appeal, removalLabel: null };

/** A row withheld from this moderator: `withheldMedia()` over it, and no appeal text or removal
 *  label of its own. */
export function withheldRow<T extends object>(row: T) {
  const { appeal, approvedAppeal } = row as {
    appeal?: object | null;
    approvedAppeal?: { removalLabel: string | null } | null;
  };
  return {
    ...row,
    ...withheldMedia(),
    ...(appeal ? { appeal: { ...appeal, message: '' } } : {}),
    ...(approvedAppeal ? { approvedAppeal: withheldApprovedAppeal(approvedAppeal) } : {}),
  } as Omit<T, keyof ReturnType<typeof withheldMedia>> & ReturnType<typeof withheldMedia>;
}

/** What a withheld cover image is sent as: no key, nothing but its id and level. */
export const blankCover = (image: { id: number; nsfwLevel: number | null }) => ({
  id: image.id,
  url: '',
  nsfwLevel: image.nsfwLevel ?? 0,
  restricted: true as const,
});

/** Each row's cover images and civitai.com face cover, with those withheld from `user` sent without
 *  their key. */
export async function withheldCoverImages<
  T extends { coverImages: AppealCoverImage[]; comFace?: ComFace | null }
>(
  rows: T[],
  user: App.Locals['user'] | undefined,
  list: string
): Promise<(Omit<T, 'coverImages'> & { coverImages: AppealCoverImage[] })[]> {
  const ids = rows.flatMap((row) => [
    ...row.coverImages.map((image) => image.id),
    ...(row.comFace?.cover ? [row.comFace.cover.id] : []),
  ]);
  const withheld = await listWithheldIds(ids, { csamReview: holdsCsamReview(user) }, list);
  return rows.map((row) => ({
    ...row,
    ...(row.comFace?.cover && withheld.has(row.comFace.cover.id)
      ? { comFace: { ...row.comFace, cover: { ...row.comFace.cover, url: '', restricted: true } } }
      : {}),
    coverImages: row.coverImages.map((image) =>
      withheld.has(image.id) ? blankCover(image) : image
    ),
  }));
}

/** A model preview with the images withheld from `user` sent with no key or flag. */
export async function withheldPreviewImages(
  preview: ModelPreview,
  user: App.Locals['user'] | undefined
): Promise<ModelPreview> {
  const withheld = await listWithheldIds(
    preview.images.map((i) => i.id),
    { csamReview: holdsCsamReview(user) },
    'model-preview'
  );
  return {
    ...preview,
    images: preview.images.map((i) =>
      withheld.has(i.id)
        ? {
            id: i.id,
            url: '',
            type: 'image',
            nsfwLevel: i.nsfwLevel,
            blocked: false,
            minor: false,
            acceptableMinor: false,
            restricted: true,
          }
        : i
    ),
  };
}

/** A file-match detail with any cover withheld from `user` sent with no key, its type and id gone too. */
export async function withheldHashDetail(
  detail: MinorHashMatchDetail | null,
  user: App.Locals['user'] | undefined
): Promise<MinorHashMatchDetail | null> {
  if (!detail) return detail;
  const ids = [detail.modelCoverId, detail.minorModelCoverId].filter(
    (id): id is number => id != null
  );
  const withheld = await listWithheldIds(
    ids,
    { csamReview: holdsCsamReview(user) },
    'minor-hash-detail'
  );
  const blank = (id: number | null) => id != null && withheld.has(id);
  return {
    ...detail,
    ...(blank(detail.modelCoverId)
      ? {
          modelCoverId: null,
          modelCoverUrl: null,
          modelCoverType: null,
          modelCoverRestricted: null,
          modelCoverWithheld: true,
        }
      : {}),
    ...(blank(detail.minorModelCoverId)
      ? {
          minorModelCoverId: null,
          minorModelCoverUrl: null,
          minorModelCoverType: null,
          minorModelCoverRestricted: null,
          minorModelCoverWithheld: true,
        }
      : {}),
  };
}

/** `restrictedImageAccess`'s kept ids. */
export async function restrictedImageIds(imageIds: number[], opts: { csamReview: boolean }) {
  return (await restrictedImageAccess(imageIds, opts)).kept;
}

/** `restrictedImageIds` for a list a page draws: a failed read withholds every id rather than
 *  failing the page. */
export async function listWithheldIds(
  imageIds: number[],
  opts: { csamReview: boolean },
  list: string
) {
  return restrictedImageIds(imageIds, opts).catch((e) => {
    void logToAxiom({
      name: 'image-queue-withheld-read-failed',
      type: 'error',
      payload: {
        list,
        count: imageIds.length,
        error: e instanceof Error ? e.name : typeof e,
      },
    });
    return new Set(imageIds);
  });
}

const MEDIA_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** The most Image rows `withheldUrls` reads; past it, every url is treated as withheld. */
const URL_MATCH_CAP = 1000;

/** Of `urls` (each a bare `Image.url` or a CDN link carrying one), those naming an image withheld
 *  from `user`. A url no Image row carries is nothing the rule could withhold, so it is not in the
 *  set. */
export async function withheldUrls(
  urls: readonly (string | null | undefined)[],
  user: App.Locals['user'] | undefined,
  list: string
): Promise<Set<string>> {
  const keysOf = (url: string) => [url, url.match(MEDIA_UUID)?.[0]].filter((k): k is string => !!k);
  const given = [...new Set(urls.filter((u): u is string => !!u))];
  const keys = [...new Set(given.flatMap(keysOf))];
  if (!keys.length) return new Set();
  // A failed read withholds every url, as `listWithheldIds` does for ids.
  const rows = await dbRead
    .selectFrom('Image')
    .select(['id', 'url'])
    .where('url', 'in', keys)
    .limit(URL_MATCH_CAP + 1)
    .execute()
    .catch((e) => {
      void logToAxiom({
        name: 'withheld-url-read-failed',
        type: 'error',
        payload: { list, count: keys.length, error: e instanceof Error ? e.name : typeof e },
      });
      return null;
    });
  if (!rows || rows.length > URL_MATCH_CAP) return new Set(given);
  const withheld = await listWithheldIds(
    rows.map((r) => r.id),
    { csamReview: holdsCsamReview(user) },
    list
  );
  const withheldKeys = new Set(rows.filter((r) => withheld.has(r.id)).map((r) => r.url));
  return new Set(given.filter((url) => keysOf(url).some((k) => withheldKeys.has(k))));
}

/** `rows` with each row whose image is withheld from `user` replaced by `blank(row)`; a row with
 *  no image id passes as it is. */
export async function withheldRows<T, B>(
  rows: T[],
  user: App.Locals['user'] | undefined,
  list: string,
  imageId: (row: T) => number | null | undefined,
  blank: (row: T) => B
): Promise<(T | B)[]> {
  const ids = rows.map(imageId).filter((id): id is number => id != null);
  if (!ids.length) return rows;
  const withheld = await listWithheldIds(ids, { csamReview: holdsCsamReview(user) }, list);
  return rows.map((row) => {
    const id = imageId(row);
    return id != null && withheld.has(id) ? blank(row) : row;
  });
}

/** The images among these withheld from `user` (`restrictedImageIds`). */
export async function withheldImageIds(user: App.Locals['user'] | undefined, imageIds: number[]) {
  return [...(await restrictedImageIds(imageIds, { csamReview: holdsCsamReview(user) }))];
}

/** The refusal for a batch with an image withheld from `user`, which acts on none of it; `null`
 *  when nothing in it is withheld. An id the primary lacks is left to the write, which reports it
 *  not found. */
export async function withheldRefusal(user: App.Locals['user'] | undefined, imageIds: number[]) {
  const { kept, missing } = await restrictedImageAccess(imageIds, {
    csamReview: holdsCsamReview(user),
  });
  const withheld = [...kept].filter((id) => !missing.has(id));
  if (!withheld.length) return null;
  return `${WITHHELD_REFUSED} Nothing was changed: ${withheld.join(', ')}.`;
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
    return `${WITHHELD_REFUSED} This account has too many images to check — nothing was changed.`;
  return withheldRefusal(
    user,
    rows.map((r) => r.id)
  );
}

/** What `/api/retracted-media` serves this moderator, held media included. */
export async function getModeratorMedia(
  imageId: number,
  { csamReview }: { csamReview: boolean }
): Promise<ModeratorMedia | null> {
  const { viewable } = await readRetractedMedia([imageId], { csamReview, orHeld: true });
  return viewable.get(imageId) ?? null;
}

/** Whether `/api/retracted-media` has no file to serve for this image by its own facts: gone,
 *  unprocessed, or a file the CDN still serves. Read without the grant's owner-level legs, so the
 *  answer is the same whatever the owner's account state. */
export async function moderatorMediaUnavailable(imageId: number): Promise<boolean> {
  const { eligible } = await readRetractedMedia([imageId], { csamReview: false, orHeld: true });
  return !eligible.has(imageId);
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
