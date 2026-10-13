import { TRPCError } from '@trpc/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { VISIBLE_COLLECTION_WHERE } from '~/server/services/text-scan/collection-visibility';
import {
  getTextScanMode,
  isTextScanEnabled,
  readTextScanRollouts,
} from '~/server/services/text-scan/mode';
import type { TextScanEntityType } from '~/server/services/text-scan/types';
import { EntityType } from '~/shared/utils/prisma/enums';

export type CutoverEntityType = Exclude<TextScanEntityType, 'Challenge' | 'Crucible'>;

type ClavataTarget = {
  clavataKey: string;
  jobQueueEntityType: EntityType | null;
  trigger: { name: string; table: string } | null;
  recentIds: () => Promise<number[]>;
};

export type DrainResult = { deleted: number; complete: boolean };
export type CutoverRefusal =
  | 'not-fully-active'
  | 'not-active'
  | 'nothing-to-probe'
  | 'override-not-allowed';

const PROBE = 20;
export const DRAIN_BATCH = 5000;
export const DRAIN_MAX_BATCHES = 200;

const ids = (rows: { id: number }[]) => rows.map((r) => r.id);
const recent = { select: { id: true }, orderBy: { id: 'desc' as const }, take: PROBE };

function standard(
  key: Exclude<CutoverEntityType, 'ChatMessage'>,
  recentIds: ClavataTarget['recentIds']
): ClavataTarget {
  return {
    clavataKey: key,
    jobQueueEntityType: EntityType[key],
    trigger: { name: `trg_moderation_${key.toLowerCase()}`, table: key },
    recentIds,
  };
}

export const CLAVATA_TARGETS: Readonly<Record<CutoverEntityType, ClavataTarget>> = {
  Model: standard('Model', async () => ids(await dbRead.model.findMany(recent))),
  Article: standard('Article', async () => ids(await dbRead.article.findMany(recent))),
  Post: standard('Post', async () => ids(await dbRead.post.findMany(recent))),
  Bounty: standard('Bounty', async () => ids(await dbRead.bounty.findMany(recent))),
  BountyEntry: standard('BountyEntry', async () => ids(await dbRead.bountyEntry.findMany(recent))),
  Comment: standard('Comment', async () => ids(await dbRead.comment.findMany(recent))),
  CommentV2: standard('CommentV2', async () => ids(await dbRead.commentV2.findMany(recent))),
  ResourceReview: standard('ResourceReview', async () =>
    ids(await dbRead.resourceReview.findMany(recent))
  ),
  User: standard('User', async () => ids(await dbRead.user.findMany(recent))),
  UserProfile: standard('UserProfile', async () =>
    (
      await dbRead.userProfile.findMany({
        select: { userId: true },
        orderBy: { userId: 'desc' },
        take: PROBE,
      })
    ).map((r) => r.userId)
  ),
  // Clavata scans chat from a cron over ChatMessage.createdAt; its trigger was never created.
  ChatMessage: {
    clavataKey: 'Chat',
    jobQueueEntityType: null,
    trigger: null,
    recentIds: async () => ids(await dbRead.chatMessage.findMany(recent)),
  },
  Collection: standard('Collection', async () =>
    ids(
      await dbRead.collection.findMany({
        ...recent,
        where: VISIBLE_COLLECTION_WHERE,
      })
    )
  ),
};

export const UNMODERATED_OVERRIDE: ReadonlySet<CutoverEntityType> = new Set(['ChatMessage']);

export function isCutoverEntityType(value: string): value is CutoverEntityType {
  return Object.hasOwn(CLAVATA_TARGETS, value);
}

export class ClavataCutoverRefused extends TRPCError {
  constructor(
    public entityType: string,
    public reason: CutoverRefusal,
    public notActive: number[] = []
  ) {
    super({
      code: 'CONFLICT',
      message: `Clavata cutover refused for ${entityType}: ${reason}${
        notActive.length ? ` (not active: ${notActive.join(', ')})` : ''
      }`,
    });
  }
}

async function readEntities() {
  const raw = await sysRedis.hGet(
    REDIS_SYS_KEYS.ENTITY_MODERATION.BASE,
    REDIS_SYS_KEYS.ENTITY_MODERATION.KEYS.ENTITIES
  );
  return (raw ? JSON.parse(String(raw)) : {}) as Record<string, boolean>;
}

/**
 * Clavata keys cut over to text scan. Kept apart from the operator-owned `ENTITIES` toggles so the
 * kill switch can put Clavata back without touching them.
 */
export async function readClavataCutover(): Promise<Set<string>> {
  return new Set(await sysRedis.sMembers(REDIS_SYS_KEYS.TEXT_SCAN.CLAVATA_CUTOVER));
}

/**
 * Clavata keys the Clavata job skips because text scan has taken them over: cut over, the kill
 * switch on, and every id of the entity type active. Anything less (a rollback to shadow, a deleted
 * rollout, a read failure) hands the key back to Clavata, so no entity is left unmoderated.
 */
export async function getTextScanOwnedClavataKeys(): Promise<Set<string>> {
  const [cutover, textScanOn, rollouts] = await Promise.all([
    readClavataCutover(),
    isTextScanEnabled(),
    readTextScanRollouts().catch(() => ({} as Awaited<ReturnType<typeof readTextScanRollouts>>)),
  ]);
  const owned = new Set<string>();
  if (!textScanOn) return owned;
  for (const [entityType, target] of Object.entries(CLAVATA_TARGETS) as [
    CutoverEntityType,
    ClavataTarget
  ][]) {
    if (cutover.has(target.clavataKey) && rollouts[entityType]?.active === 100)
      owned.add(target.clavataKey);
  }
  return owned;
}

export async function drainModerationQueue(entityType: EntityType): Promise<DrainResult> {
  let deleted = 0;
  for (let i = 0; i < DRAIN_MAX_BATCHES; i++) {
    const n = await dbWrite.$executeRaw`
      DELETE FROM "JobQueue"
      WHERE ("entityType", "entityId", type) IN (
        SELECT "entityType", "entityId", type FROM "JobQueue"
        WHERE type = 'ModerationRequest'::"JobQueueType" AND "entityType" = ${entityType}::"EntityType"
        LIMIT ${DRAIN_BATCH}
      )`;
    deleted += n;
    if (n < DRAIN_BATCH) return { deleted, complete: true };
  }
  return { deleted, complete: false };
}

async function assertActiveEverywhere(entityType: CutoverEntityType, target: ClavataTarget) {
  // The same rule the Clavata job uses to step aside: below it, the drain would delete queued rows
  // for ids that text scan only shadows.
  const [textScanOn, rollouts] = await Promise.all([isTextScanEnabled(), readTextScanRollouts()]);
  if (!textScanOn || rollouts[entityType]?.active !== 100)
    throw new ClavataCutoverRefused(entityType, 'not-fully-active');
  const probeIds = await target.recentIds();
  if (!probeIds.length) throw new ClavataCutoverRefused(entityType, 'nothing-to-probe');
  const modes = await Promise.all(probeIds.map((id) => getTextScanMode(entityType, id)));
  const notActive = probeIds.filter((_, i) => modes[i] !== 'active');
  if (notActive.length) throw new ClavataCutoverRefused(entityType, 'not-active', notActive);
  return probeIds.length;
}

export async function disableClavataFor(
  entityType: CutoverEntityType,
  opts: { allowUnmoderated?: boolean } = {}
) {
  const target = CLAVATA_TARGETS[entityType];
  const unmoderatedOverride = !!opts.allowUnmoderated;
  if (unmoderatedOverride && !UNMODERATED_OVERRIDE.has(entityType))
    throw new ClavataCutoverRefused(entityType, 'override-not-allowed');
  const probed = unmoderatedOverride ? 0 : await assertActiveEverywhere(entityType, target);

  await sysRedis.sAdd(REDIS_SYS_KEYS.TEXT_SCAN.CLAVATA_CUTOVER, target.clavataKey);
  if (unmoderatedOverride)
    await logToAxiom({
      name: 'text-scan-clavata-cutover',
      type: 'warning',
      message: 'Chat cut over without an active text-scan check',
      entityType,
    }).catch(() => null);

  const drain = target.jobQueueEntityType
    ? await drainModerationQueue(target.jobQueueEntityType)
    : null;
  return { entityType, clavataKey: target.clavataKey, probed, unmoderatedOverride, drain };
}

export async function enableClavataFor(entityType: CutoverEntityType) {
  const target = CLAVATA_TARGETS[entityType];
  await sysRedis.sRem(REDIS_SYS_KEYS.TEXT_SCAN.CLAVATA_CUTOVER, target.clavataKey);
  return { entityType, clavataKey: target.clavataKey, cutover: [...(await readClavataCutover())] };
}

export async function getClavataCutoverStatus() {
  const [entities, cutover, owned, triggers, queue] = await Promise.all([
    readEntities(),
    readClavataCutover(),
    getTextScanOwnedClavataKeys(),
    dbRead.$queryRaw<{ name: string }[]>`
      SELECT tgname AS name FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'trg_moderation_%'`,
    dbRead.$queryRaw<{ entityType: string; count: number }[]>`
      SELECT "entityType"::text AS "entityType", count(*)::int AS count
      FROM "JobQueue" WHERE type = 'ModerationRequest'::"JobQueueType" GROUP BY 1`,
  ]);
  return Object.entries(CLAVATA_TARGETS).map(([entityType, t]) => ({
    entityType,
    clavataKey: t.clavataKey,
    clavataDisabled: entities[t.clavataKey] === false,
    cutOver: cutover.has(t.clavataKey),
    clavataSkipped: entities[t.clavataKey] === false || owned.has(t.clavataKey),
    trigger: t.trigger?.name ?? null,
    triggerPresent: t.trigger ? triggers.some((r) => r.name === t.trigger?.name) : null,
    jobQueueRows: t.jobQueueEntityType
      ? queue.find((q) => q.entityType === t.jobQueueEntityType)?.count ?? 0
      : null,
  }));
}
