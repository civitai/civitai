import { randomUUID } from 'node:crypto';
import { civitaiAppUrl, civitaiLinkUrl } from './civitai-url';
import { getIsSafeBrowsingLevel } from '@civitai/shared';
import { sql } from '@civitai/db/kysely';
import { violationUserMessage } from '$lib/violations';
import { deprecatedNsfwName } from '$lib/nsfw-levels';
import { REDIS_KEYS, REDIS_SYS_KEYS } from '@civitai/redis';
import { NotificationCategory } from '@civitai/notifications';
import { isSafeToRetry } from '@civitai/buzz';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { dbRead, dbWrite } from './db';
import { getBuzz } from './buzz';
import { bustCacheTag, bustCachedObject } from './cache';
import { getClickhouse } from './clickhouse';
import { getNotifications } from './notifications';
import { songNoticeSubject, songTosNoticeDetails } from '@civitai/db-queries/profile-picture-clear';
import { getSysRedis } from './redis';
import { evictHomeBlocks } from './home-blocks';
import { syncSearchIndex, syncSearchIndexBulk } from './search-index';
import { parkModelSearchUpdates } from './search-index-park';
import { logAxiomError, logToAxiom } from './axiom';
import { recordLikenessRequest } from './mod-activity';
import { appealResolutionEmail } from './emails/appeal-resolution.email';
import { isFeedbackCaptureOwner } from '@civitai/shared/feedback-capture';
import { mirrorBlockedHashesSql, NEWEST_BLOCKLIST_ROW_SQL } from '@civitai/shared/held-media';

/**
 * Run a post-write side effect so it cannot fail the moderation action that already happened.
 *
 * These run AFTER the Image row is blocked or accepted, and none of them can undo it: a ClickHouse
 * blocklist row, a Redis invalidation, a comic re-queue. When one threw, the whole action rejected and
 * the moderator got a 500 page for work that had in fact succeeded — reported as "actioning items still
 * causes 500 error, but does action" on both Comics Review and the image queues (2026-08-12). Retrying
 * is then the worst move available, because the write is already done.
 *
 * `trackImageDeleteTos` and `notifyImageTosViolation` already swallowed their own failures, which is
 * why the same click was sometimes fine — this makes the rest of the set behave the same way, and logs
 * so a degraded dependency is visible instead of silent.
 */
async function bestEffort(
  step: string,
  imageId: number,
  run: () => Promise<unknown>
): Promise<void> {
  try {
    await run();
  } catch (error) {
    void logAxiomError(error, { event: 'image moderation side effect failed', step, imageId });
  }
}

// The legacy always stored 'TOS' here — its one caller fed `blockedFor ?? 'moderated'`, which never matched
// the CSAM/newUser keys (a latent bug). We key off needsReview to store the intended reason; do NOT "fix"
// this back to always-'TOS'.
function reviewTypeToBlockReason(reason: string | null | undefined): 'Ownership' | 'CSAM' | 'TOS' {
  switch (reason) {
    case 'csam':
      return 'CSAM';
    case 'newUser':
      return 'Ownership';
    default:
      return 'TOS';
  }
}

/** Only a confirmed CSAM block (`csam`) writes a CSAM entry; the review flag alone maps to TOS. */
function nonCsamReason(reason: string | null | undefined): 'Ownership' | 'TOS' {
  const mapped = reviewTypeToBlockReason(reason);
  return mapped === 'CSAM' ? 'TOS' : mapped;
}

export async function queueComicsForImages(imageIds: number[]): Promise<void> {
  if (!imageIds.length) return;
  const rows = await dbRead
    .selectFrom('ComicPanel')
    .select('projectId')
    .distinct()
    .where('imageId', 'in', imageIds)
    .execute();
  for (const { projectId } of rows)
    syncSearchIndex({ entityType: 'comic', entityId: projectId, action: 'update' });
}

// Per-key set to avoid CROSSSLOT; write the exact `'false'` value the main app's existence reader expects.
export async function invalidateImagesExistence(imageIds: number[]): Promise<void> {
  if (!imageIds.length) return;
  const sys = getSysRedis();
  await Promise.all(
    imageIds.map((id) =>
      sys.packed.set(`${REDIS_SYS_KEYS.CACHES.IMAGE_EXISTS}:${id}`, 'false', { EX: 60 * 5 })
    )
  );
}

// dbRead is safe here: Post→version/model links don't change on a moderation write.
export async function bustPostGalleryCaches(postIds: number[]): Promise<void> {
  const ids = [...new Set(postIds.filter((id) => id != null))];
  if (!ids.length) return;
  const rows = await dbRead
    .selectFrom('Post as p')
    .leftJoin('ModelVersion as mv', 'mv.id', 'p.modelVersionId')
    .leftJoin('Model as m', 'm.id', 'mv.modelId')
    .select([
      'p.modelVersionId as modelVersionId',
      'mv.modelId as modelId',
      'p.model3dId as model3dId',
      sql<boolean>`m."userId" = p."userId"`.as('isShowcase'),
    ])
    .where('p.id', 'in', ids)
    .execute();

  const modelVersionIds = [
    ...new Set(rows.map((r) => r.modelVersionId).filter((x): x is number => x != null)),
  ];
  const modelIds = [...new Set(rows.map((r) => r.modelId).filter((x): x is number => x != null))];
  const model3dIds = [
    ...new Set(rows.map((r) => r.model3dId).filter((x): x is number => x != null)),
  ];

  const tags = [
    ...modelVersionIds.map((id) => `images-modelVersion:${id}`),
    ...modelIds.map((id) => `images-model:${id}`),
    ...model3dIds.map((id) => `images-model3d:${id}`),
  ];
  await Promise.all([
    tags.length ? bustCacheTag(tags) : Promise.resolve(),
    bustCachedObject(REDIS_KEYS.CACHES.IMAGES_FOR_MODEL_VERSION, modelVersionIds),
  ]);

  // The models sync re-picks a model only when `Model.updatedAt` moves; a showcase image that stops
  // qualifying would otherwise stay in its search document.
  const showcaseModelIds = [
    ...new Set(rows.filter((r) => r.isShowcase && r.modelId != null).map((r) => r.modelId!)),
  ];
  await syncSearchIndexBulk(
    { entityType: 'model', entityIds: showcaseModelIds, action: 'update' },
    { strict: true }
  ).catch(() => parkModelSearchUpdates(showcaseModelIds));
}

// Keep pHash as the full-precision string: it's a signed 64-bit value that overflows JS `number`
// (`Number(hash)` truncates), and the re-upload match needs the exact bigint. ClickHouse parses the Int64.
type BlockableImage = {
  pHash: string | null;
  needsReview: string | null;
  blockedFor: string | null;
};

/**
 * Hashes among these with a live CSAM entry. The table keeps the newest row per hash when it
 * merges, so a later row of any other reason would replace that entry. Only the newest row per
 * hash (argMax on created_at, merged or not) decides, so a CSAM row that a newer row has replaced
 * or disabled does not count as live. created_at is whole seconds; on a tie the live CSAM row wins,
 * so a tie can over-block but never drops a live CSAM entry. The filter runs on that row, outside
 * the aggregate; this needs no FINAL and no query setting.
 * The main app has the same guard (src/server/services/image.service.ts); change both.
 */
async function csamBlockedHashes(hashes: string[]): Promise<Set<string>> {
  if (!hashes.length) return new Set();
  try {
    const resultSet = await getClickhouse().query({
      query: `SELECT toString(hash) AS hash FROM (SELECT hash, ${NEWEST_BLOCKLIST_ROW_SQL} AS newest FROM "blocked_images" WHERE hash IN (${hashes.join(
        ','
      )}) GROUP BY hash) WHERE tupleElement(newest, 1) = 'CSAM' AND tupleElement(newest, 2) = false`,
      format: 'JSONEachRow',
    });
    const rows = await resultSet.json<{ hash: string }>();
    return new Set(rows.map((row) => row.hash));
  } catch (error) {
    throw new BlocklistStoreError(error, 'blocked_images: the CSAM-entry check failed');
  }
}

export const CSAM_BLOCKLIST_RETRY =
  'The image was blocked, but its CSAM blocklist entry could not be written. Block it again to retry.';

/** Where a CSAM entry failed to land: the ClickHouse blocklist, or its Postgres held-media copy. */
export type CsamBlocklistStore = 'blocklist' | 'held-media-copy';

/** A block that committed, but whose CSAM blocklist entry was not written. */
export class CsamBlocklistWriteError extends Error {
  readonly status = 502;
  /** What `blockImage` would have returned: a held image's reports stay open. */
  skipped?: true;
  constructor(readonly imageId: number, readonly failedStore: CsamBlocklistStore = 'blocklist') {
    super(CSAM_BLOCKLIST_RETRY);
  }
}

/** An error's class and code, never its message, which can quote a statement and its hashes. */
const errorClass = (error: unknown) => ({
  errorName: (error as Error)?.name,
  errorCode: (error as { code?: unknown })?.code,
});

/**
 * A blocklist store call failed. Only the driver error's class and code are kept: its message can
 * quote the statement, hashes included, and callers log it. Twin: the main app's BlocklistStoreError.
 */
class BlocklistStoreError extends Error {
  readonly code: unknown;
  constructor(failure: unknown, message = 'blocked_images: the blocklist call failed') {
    const { errorName, errorCode } = errorClass(failure);
    super(message, { cause: { name: errorName, code: errorCode } });
    this.name = 'BlocklistStoreError';
    this.code = errorCode;
  }
}

/** Runs one blocklist store call, rethrowing its failure as a BlocklistStoreError. */
async function blocklistCall<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new BlocklistStoreError(error);
  }
}

/** The blocklist entries were written but their Postgres copy failed. Its message holds no hash. */
class HeldMediaCopyError extends Error {
  constructor(failure: unknown) {
    super('the held-media copy of the blocklist entries failed', { cause: errorClass(failure) });
  }
}

/** It runs inside a moderator's request, so every attempt and wait fits in this. */
const COPY_BUDGET_MS = 1_500;
const COPY_ATTEMPTS = 3;
const COPY_BACKOFF_MS = [100, 300];
/** An attempt with less time than this left would only time out. */
const COPY_MIN_ATTEMPT_MS = 50;

/**
 * The Postgres copy of the CSAM entries, which review routing reads. Retried within COPY_BUDGET_MS,
 * then throws HeldMediaCopyError. An abandoned attempt may still land, which is harmless: the upsert
 * is idempotent. Twin: the main app's mirrorCsamEntries (src/server/services/image.service.ts).
 */
async function mirrorCsamEntries(hashes: string[], context?: BlocklistWriteContext) {
  const statement = mirrorBlockedHashesSql(hashes);
  if (!statement) return;
  const deadline = Date.now() + COPY_BUDGET_MS;
  let lastError: unknown = new Error('no attempt fit the budget');
  let attempts = 0;
  while (attempts < COPY_ATTEMPTS && Date.now() < deadline) {
    if (attempts > 0) {
      const wait = Math.min(COPY_BACKOFF_MS[attempts - 1], deadline - Date.now());
      await new Promise((resolve) => setTimeout(resolve, wait));
      if (deadline - Date.now() < COPY_MIN_ATTEMPT_MS) break;
    }
    attempts++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        sql.raw(statement).execute(dbWrite),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('copy attempt timed out')),
            Math.max(deadline - Date.now(), 0)
          );
        }),
      ]);
      return;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }
  void logToAxiom({
    type: 'error',
    name: 'held-media-copy-failed',
    message: 'the held-media copy of the blocklist entries failed',
    payload: {
      step: context?.step,
      imageId: context?.imageId,
      actorUserId: context?.actorUserId,
      hashCount: hashes.length,
      attempts,
      ...errorClass(lastError),
    },
  });
  throw new HeldMediaCopyError(lastError);
}

/** Who and what a blocklist write is for, so a write left undone can be traced and counted. */
export type BlocklistWriteContext = { step: string; imageId?: number; actorUserId?: number };

/** The CSAM-entry check failed, so the blocklist was left unchanged for these hashes. Logged to be counted. */
function logBlocklistCheckFailed(
  name: 'blocklist-insert-skipped' | 'blocklist-disable-refused',
  rows: { hash: string; reason: string }[],
  context: BlocklistWriteContext | undefined,
  error: unknown
) {
  void logToAxiom({
    type: 'error',
    name,
    message: 'blocked_images left unchanged: the CSAM-entry check failed',
    payload: {
      step: context?.step,
      imageId: context?.imageId,
      actorUserId: context?.actorUserId,
      hashCount: rows.length,
      reasons: rows.map(({ reason }) => reason),
      error: error instanceof Error ? error.message : String(error),
    },
  });
}

/**
 * A hash with a CSAM entry keeps it: other reasons are not written over it. CSAM rows are written
 * first and never wait on that lookup; if the lookup fails, the rest are skipped and logged
 * (`blocklist-insert-skipped`) and the call resolves, so the block itself stands.
 */
export async function addImagesToBlocklist(
  images: (BlockableImage & { csam?: boolean })[],
  context?: BlocklistWriteContext
): Promise<void> {
  const candidates = images
    .filter((i): i is BlockableImage & { pHash: string; csam?: boolean } => !!i.pHash)
    .map((i) => ({
      hash: i.pHash,
      reason: i.csam ? 'CSAM' : nonCsamReason(i.blockedFor ?? i.needsReview),
    }));
  const write = async (values: typeof candidates, sync = false) => {
    if (values.length)
      await blocklistCall(() =>
        getClickhouse().insert({
          table: 'blocked_images',
          values,
          format: 'JSONEachRow',
          // Synchronous: the async default acknowledges before the flush, hiding a flush-time loss.
          ...(sync && { clickhouse_settings: { async_insert: 0 } }),
        })
      );
  };

  const csamRows = candidates.filter((v) => v.reason === 'CSAM');
  await write(csamRows, true);
  // The Postgres copy review routing reads; it throws like the write above. Twin: the main app's
  // bulkAddBlockedImages.
  await mirrorCsamEntries(
    csamRows.map((v) => v.hash),
    context
  );
  const inBatch = new Set(csamRows.map((v) => v.hash));
  const others = candidates.filter((v) => v.reason !== 'CSAM' && !inBatch.has(v.hash));
  if (!others.length) return;
  let csam: Set<string>;
  try {
    csam = await csamBlockedHashes(others.map((v) => v.hash));
  } catch (error) {
    logBlocklistCheckFailed('blocklist-insert-skipped', others, context, error);
    return;
  }
  await write(others.filter((v) => !csam.has(v.hash)));
}

/**
 * Disables the live entries of these hashes, except a hash with a live CSAM entry. If that check
 * fails, nothing is disabled (the entries stay) and the refusal is logged.
 */
export async function removeImagesFromBlocklist(
  pHashes: (string | null)[],
  context?: BlocklistWriteContext
): Promise<void> {
  const hashes = pHashes.filter((h): h is string => !!h);
  if (!hashes.length) return;
  const ch = getClickhouse();
  let blocked: { hash: string; reason: string }[];
  let csam: Set<string>;
  try {
    [blocked, csam] = await Promise.all([
      blocklistCall(async () => {
        const resultSet = await ch.query({
          query: `SELECT toString(hash) AS hash, reason FROM "blocked_images" WHERE hash IN (${hashes.join(
            ','
          )}) AND disabled = false`,
          format: 'JSONEachRow',
        });
        return resultSet.json<{ hash: string; reason: string }>();
      }),
      csamBlockedHashes(hashes),
    ]);
  } catch (error) {
    logBlocklistCheckFailed(
      'blocklist-disable-refused',
      hashes.map((hash) => ({ hash, reason: 'unknown' })),
      context,
      error
    );
    return;
  }
  if (csam.size)
    void logToAxiom({
      type: 'info',
      name: 'blocklist-disable-kept-csam',
      message: 'an unblock left hashes with a live CSAM entry in place',
      payload: { step: context?.step, imageId: context?.imageId, hashCount: csam.size },
    });
  const disable = blocked.filter((b) => !csam.has(b.hash));
  if (!disable.length) return;
  await blocklistCall(() =>
    ch.insert({
      table: 'blocked_images',
      values: disable.map((b) => ({ hash: b.hash, reason: b.reason, disabled: true })),
      format: 'JSONEachRow',
    })
  );
}

const NEEDS_REVIEW_TO_VIOLATION: Record<string, string> = {
  minor: 'realisticMinor',
  poi: 'realPerson',
  csam: 'realisticMinorNsfw',
  tag: 'other',
  newUser: 'other',
  blocked: 'other',
  appeal: 'other',
  bestiality: 'bestiality',
};

const REPORT_VIOLATION_TO_TYPE: Record<string, string> = {
  'Depiction of real-person likeness': 'realPerson',
  'Graphic violence': 'gore',
  'False impersonation': 'other',
  'Deceptive content': 'other',
  'Sale of illegal substances': 'other',
  'Child abuse and exploitation': 'realisticMinorNsfw',
  'Photorealistic depiction of a minor': 'realisticMinor',
  'Prohibited concepts': 'other',
};

function mapToViolationType(
  needsReview: string | null | undefined,
  reportViolation: string | null | undefined
): string {
  if (reportViolation && REPORT_VIOLATION_TO_TYPE[reportViolation])
    return REPORT_VIOLATION_TO_TYPE[reportViolation];
  if (needsReview && NEEDS_REVIEW_TO_VIOLATION[needsReview])
    return NEEDS_REVIEW_TO_VIOLATION[needsReview];
  return 'other';
}

export type ImageDeleteTosInput = {
  imageId: number;
  ownerId: number;
  // nsfwLevel BEFORE the block write.
  nsfwLevel: number;
  needsReview: string | null;
  actorUserId: number;
  ip?: string;
  userAgent?: string;
  violationType?: string;
  violationDetails?: string;
};

const activeTagNames = async (imageId: number) =>
  (
    await dbRead
      .selectFrom('TagsOnImageDetails as toi')
      .innerJoin('Tag as t', 't.id', 'toi.tagId')
      .select('t.name')
      .where('toi.imageId', '=', imageId)
      .where('toi.disabled', '=', false)
      .execute()
  ).map((r) => r.name);

export async function trackImageDeleteTos(input: ImageDeleteTosInput): Promise<void> {
  const { imageId, ownerId, nsfwLevel, needsReview, actorUserId } = input;
  try {
    const [tags, resourceRows, reportRes] = await Promise.all([
      activeTagNames(imageId),
      dbRead
        .selectFrom('ImageResourceNew')
        .select('modelVersionId')
        .where('imageId', '=', imageId)
        .execute(),
      sql<{ violation: string | null; comment: string | null }>`
        SELECT r.details->>'violation' AS violation, r.details->>'comment' AS comment
        FROM "Report" r
        JOIN "ImageReport" ir ON ir."reportId" = r.id
        WHERE ir."imageId" = ${imageId} AND r.reason = 'TOSViolation'
        ORDER BY r."createdAt" DESC
        LIMIT 1
      `.execute(dbRead),
    ]);

    const report = reportRes.rows[0];
    await getClickhouse().insert({
      table: 'images',
      values: [
        {
          type: 'DeleteTOS',
          userId: actorUserId,
          imageId,
          tags,
          nsfw: deprecatedNsfwName(nsfwLevel),
          ip: input.ip ?? 'unknown',
          userAgent: input.userAgent ?? 'unknown',
          ownerId,
          // The moderator's explicit call outranks the queue the image came from — this field is what
          // the appeal queue shows the next reviewer as the reason for removal.
          tosReason: input.violationType ?? needsReview ?? 'other',
          violationType: input.violationType ?? mapToViolationType(needsReview, report?.violation),
          violationDetails: input.violationDetails ?? report?.comment ?? '',
          resources: resourceRows.map((r) => r.modelVersionId),
          via: 'web',
          viaClientId: '',
          viaApiKeyId: 0,
        },
      ],
      format: 'JSONEachRow',
    });
  } catch (e) {
    console.error('trackImageDeleteTos failed', { imageId, error: (e as Error).message });
  }
}

/** A restore of a removed image, as the main app's `/api/mod/restore-images` logs it. Without it the
 *  User Lookup's Image removals list shows the removal as standing after the image came back. */
export async function trackImageRestore(input: {
  imageId: number;
  actorUserId: number;
  db?: Kysely<DB>;
}): Promise<void> {
  const { imageId, actorUserId, db = dbRead } = input;
  try {
    const [image, tags] = await Promise.all([
      db
        .selectFrom('Image')
        .select(['userId', 'nsfwLevel'])
        .where('id', '=', imageId)
        .executeTakeFirst(),
      activeTagNames(imageId),
    ]);
    if (!image) return;
    await getClickhouse().insert({
      table: 'images',
      values: [
        {
          type: 'Restore',
          userId: actorUserId,
          imageId,
          ownerId: image.userId,
          tags,
          nsfw: deprecatedNsfwName(image.nsfwLevel),
          ip: 'unknown',
          userAgent: 'unknown',
          via: 'web',
          viaClientId: '',
          viaApiKeyId: 0,
        },
      ],
      format: 'JSONEachRow',
    });
  } catch (e) {
    console.error('trackImageRestore failed', { imageId, error: (e as Error).message });
  }
}

export async function notifyImageTosViolation(image: {
  imageId: number;
  ownerId: number;
  postId: number | null;
  /** The moderator's own wording for what was wrong. Omitted where they did not pick one — the main
   *  app's processor keeps the unreasoned message for that case, and for every notification written
   *  before this field existed. */
  reason?: string;
}): Promise<boolean> {
  if (isFeedbackCaptureOwner(image.ownerId)) return false;
  try {
    // A song or its cover names the song (the template's "song" / "song cover" wording) and links to
    // it; a lookup that fails sends the image wording rather than no notice.
    const song = await songNoticeSubject(dbRead, image.imageId).catch(() => null);
    await getNotifications().createNotification({
      userId: image.ownerId,
      type: 'tos-violation',
      category: NotificationCategory.System,
      key: `tos-violation:image:${randomUUID()}`,
      details: {
        ...(song
          ? songTosNoticeDetails(song)
          : {
              modelName: image.postId ? `post #${image.postId}` : 'a post',
              entity: 'image',
              url: `/images/${image.imageId}`,
            }),
        ...(image.reason ? { reason: image.reason } : {}),
      },
    });
    return true;
  } catch {
    // onFailure already logged; best-effort.
    return false;
  }
}

export async function applyVisibilitySideEffects(
  imageId: number,
  postId: number | null
): Promise<void> {
  await Promise.all([
    bustPostGalleryCaches(postId != null ? [postId] : []),
    queueComicsForImages([imageId]),
  ]);
}

// `img` is the PRE-block row (captured before the update).
export type BlockedImageRow = {
  pHash: string | null;
  needsReview: string | null;
  blockedFor: string | null;
  nsfwLevel: number;
  postId: number | null;
  userId: number;
};

export async function applyBlockSideEffects(
  img: BlockedImageRow,
  actor: {
    imageId: number;
    actorUserId: number;
    ip?: string;
    userAgent?: string;
    violationType?: string;
    violationDetails?: string;
    /** `HELD_IMAGE` as the block wrote it. */
    heldImage?: boolean;
    /** `blockedFor = 'CSAM'` as the block wrote it: a confirmed CSAM removal. */
    removedForCsam?: boolean;
    /** Under the review flag as the block wrote it. */
    underReview?: boolean;
  }
): Promise<void> {
  const { imageId, actorUserId, ip, userAgent, violationType, violationDetails } = actor;
  const { heldImage, underReview } = actor;
  if (!heldImage && underReview)
    void logToAxiom({
      type: 'warning',
      name: 'image-notice-under-review',
      imageId,
      userId: img.userId,
    });
  const csamBlocklistFailures: CsamBlocklistWriteError[] = [];
  await Promise.all([
    // Reported to the caller once the rest has run.
    writeBlockBlocklistEntry(img, {
      imageId,
      actorUserId,
      csam: !!actor.removedForCsam,
    }).catch((error: unknown) => {
      if (!(error instanceof CsamBlocklistWriteError)) throw error;
      csamBlocklistFailures.push(error);
    }),
    trackImageDeleteTos({
      imageId,
      ownerId: img.userId,
      nsfwLevel: img.nsfwLevel,
      needsReview: img.needsReview,
      actorUserId,
      ip,
      userAgent,
      violationType,
      violationDetails,
    }),
    heldImage
      ? undefined
      : notifyImageTosViolation({
          imageId,
          ownerId: img.userId,
          postId: img.postId,
          // The chosen violation only — not the one `trackImageDeleteTos` infers for analytics.
          // Telling someone their image broke a rule no moderator picked is worse than telling
          // them nothing.
          reason: violationType ? violationUserMessage(violationType) : undefined,
        }),
    violationType === 'likenessRequest' ? recordLikenessRequest(actorUserId, imageId) : undefined,
    bestEffort('invalidate-existence', imageId, () => invalidateImagesExistence([imageId])),
    bestEffort('visibility', imageId, () => applyVisibilitySideEffects(imageId, img.postId)),
    evictHomeBlocks([imageId]),
  ]);
  if (csamBlocklistFailures.length) throw csamBlocklistFailures[0];
}

/**
 * A block's blocklist entry: CSAM only for a confirmed CSAM block (`csam`); the review flag alone
 * writes TOS. A CSAM entry is not best-effort: its failure throws CsamBlocklistWriteError naming the
 * store that failed.
 */
export async function writeBlockBlocklistEntry(
  img: BlockableImage,
  { imageId, actorUserId, csam }: { imageId: number; actorUserId: number; csam: boolean }
): Promise<void> {
  if (csam && !img.pHash) {
    // The block itself succeeds. Twin: the main app's logCsamBlocklistNoHash.
    void logToAxiom({
      type: 'warning',
      name: 'csam-blocklist-no-hash',
      message: 'a CSAM removal had no hash to write to the blocklist',
      payload: { imageId, step: 'block' },
    });
    return;
  }
  const write = () =>
    addImagesToBlocklist(
      [{ pHash: img.pHash, needsReview: img.needsReview, blockedFor: img.blockedFor, csam }],
      { step: 'block', imageId, actorUserId }
    );
  if (!csam) return bestEffort('blocklist', imageId, write);
  try {
    await write();
  } catch (error) {
    const failedStore = error instanceof HeldMediaCopyError ? 'held-media-copy' : 'blocklist';
    void logToAxiom({
      type: 'error',
      name: 'csam-blocklist-write-failed',
      message: 'the CSAM blocklist entry for a block was not written',
      payload: { step: 'block', imageCount: 1, actorUserId, failedStore, ...errorClass(error) },
    });
    throw new CsamBlocklistWriteError(imageId, failedStore);
  }
}

export async function applyAcceptSideEffects(
  img: { pHash: string | null; postId: number | null },
  imageId: number,
  actorUserId?: number
): Promise<void> {
  await Promise.all([
    bestEffort('unblocklist', imageId, () =>
      removeImagesFromBlocklist([img.pHash], { step: 'unblock', imageId, actorUserId })
    ),
    bestEffort('visibility', imageId, () => applyVisibilitySideEffects(imageId, img.postId)),
  ]);
}

const isAppealPrefix = (prefix: string) => prefix.startsWith('appeal-');

// A multi-account appeal charge uses an `appeal-`-prefixed external id → refundMultiTransaction.
export async function refundAppealFee(appeal: {
  id: number;
  buzzTransactionId: string | null;
  entityType: string;
  entityId: number;
}): Promise<boolean> {
  if (!appeal.buzzTransactionId) return false;
  const description = `Refunded appeal ${appeal.id} for ${appeal.entityType} ${appeal.entityId}`;
  try {
    if (isAppealPrefix(appeal.buzzTransactionId))
      // A timed-out refund may still land, so only a request that never reached Buzz is retried.
      await getBuzz().refundMultiTransaction(
        { externalTransactionIdPrefix: appeal.buzzTransactionId, description },
        { shouldRetry: isSafeToRetry }
      );
    else await getBuzz().refundTransaction(appeal.buzzTransactionId, { description });
    return true;
  } catch (e) {
    // The appeal is already closed, so this is the only record that the fee is still owed.
    void logAxiomError(e, {
      event: 'appeal fee refund failed',
      appealId: appeal.id,
      buzzTransactionId: appeal.buzzTransactionId,
    });
    return false;
  }
}

/** civitai.com will not show a mature, mixed or unrated image; those, a missing row and a failed read
 *  are left out, so their links go to .red, which serves every level. */
async function comServableImageIds(imageIds: number[]): Promise<Set<number>> {
  try {
    const rows = await dbRead
      .selectFrom('Image')
      .select(['id', 'nsfwLevel'])
      .where('id', 'in', imageIds)
      .execute();
    return new Set(rows.filter((r) => getIsSafeBrowsingLevel(r.nsfwLevel)).map((r) => r.id));
  } catch {
    return new Set();
  }
}

export async function notifyAppealResolved(input: {
  appeal: { id: number; userId: number };
  entityType?: string;
  entityId: number;
  status: 'Approved' | 'Rejected';
  resolvedMessage?: string;
  /** Read by the main app's `entity-appeal-resolved` copy, e.g. a site appeal's `category`. */
  details?: Record<string, unknown>;
}): Promise<void> {
  const entityType = input.entityType ?? 'Image';
  try {
    // The bell resolves a relative path on its own host, so an image civitai.com does not serve needs
    // an absolute .red url. A site appeal's copy builds its own link and ignores `url`.
    const redUrl =
      entityType === 'Image' &&
      !input.details?.category &&
      !(await comServableImageIds([input.entityId])).has(input.entityId)
        ? `${civitaiLinkUrl()}/images/${input.entityId}`
        : undefined;
    await getNotifications().createNotification({
      userId: input.appeal.userId,
      type: 'entity-appeal-resolved',
      category: NotificationCategory.Moderation,
      // Per appeal, matching the main app: a repeated key reuses the first decision's notification.
      key: `entity-appeal-resolved:${entityType}:${input.entityId}:${input.appeal.id}`,
      details: {
        ...input.details,
        ...(redUrl && { url: redUrl }),
        entityType,
        entityId: input.entityId,
        status: input.status,
        resolvedMessage: input.resolvedMessage ?? '',
      },
    });
  } catch {
    // onFailure already logged; best-effort.
  }
}

// resolvedMessage is intentionally NOT emailed — only the decision + item links.
export async function emailAppealResolution(input: {
  to: string;
  username: string;
  approved: boolean;
  imageIds: number[];
  /** The appellant's user id, carried by the email's tracked links. */
  userId?: number;
}): Promise<void> {
  if (!input.imageIds.length) return;
  try {
    const comSafe = await comServableImageIds(input.imageIds);
    const base = (id: number) => (comSafe.has(id) ? civitaiAppUrl() : civitaiLinkUrl());
    await appealResolutionEmail.send(
      {
        to: input.to,
        username: input.username,
        approved: input.approved,
        items: input.imageIds.map((id) => ({
          url: `${base(id)}/images/${id}`,
          label: `Image #${id}`,
        })),
      },
      { userId: input.userId }
    );
  } catch (e) {
    console.error('emailAppealResolution failed', {
      imageIds: input.imageIds,
      error: (e as Error).message,
    });
  }
}
