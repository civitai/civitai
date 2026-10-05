import { TRPCError } from '@trpc/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { getTextScanMode } from '~/server/services/text-scan/mode';
import type { TextScanEntityType } from '~/server/services/text-scan/types';
import { EntityType } from '~/shared/utils/prisma/enums';

export type CutoverEntityType = Exclude<TextScanEntityType, 'Challenge' | 'Crucible'>;
type ProbedEntityType = Exclude<CutoverEntityType, 'Collection'>;

type ClavataTarget = {
  clavataKey: string;
  jobQueueEntityType: EntityType | null;
  trigger: { name: string; table: string } | null;
  recentIds: (() => Promise<number[]>) | null;
};

export type DrainResult = { deleted: number; complete: boolean };
export type CutoverRefusal =
  | 'not-active'
  | 'nothing-to-probe'
  | 'override-required'
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
  Collection: standard('Collection', null),
};

export const UNMODERATED_OVERRIDE: ReadonlySet<CutoverEntityType> = new Set([
  'ChatMessage',
  'Collection',
]);

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

async function writeEntities(entities: Record<string, boolean>) {
  await sysRedis.hSet(
    REDIS_SYS_KEYS.ENTITY_MODERATION.BASE,
    REDIS_SYS_KEYS.ENTITY_MODERATION.KEYS.ENTITIES,
    JSON.stringify(entities)
  );
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
  if (!target.recentIds) throw new ClavataCutoverRefused(entityType, 'override-required');
  const probeIds = await target.recentIds();
  if (!probeIds.length) throw new ClavataCutoverRefused(entityType, 'nothing-to-probe');
  const modes = await Promise.all(
    probeIds.map((id) => getTextScanMode(entityType as ProbedEntityType, id))
  );
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

  const entities = await readEntities();
  entities[target.clavataKey] = false;
  await writeEntities(entities);
  if (unmoderatedOverride)
    await logToAxiom({
      name: 'text-scan-clavata-cutover',
      type: 'warning',
      message: 'Clavata disabled without an active text-scan',
      entityType,
    }).catch(() => null);

  const drain = target.jobQueueEntityType
    ? await drainModerationQueue(target.jobQueueEntityType)
    : null;
  return { entityType, clavataKey: target.clavataKey, probed, unmoderatedOverride, drain };
}

export async function enableClavataFor(entityType: CutoverEntityType) {
  const target = CLAVATA_TARGETS[entityType];
  const entities = await readEntities();
  delete entities[target.clavataKey];
  await writeEntities(entities);
  return { entityType, clavataKey: target.clavataKey, entities };
}

export async function getClavataCutoverStatus() {
  const [entities, triggers, queue] = await Promise.all([
    readEntities(),
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
    trigger: t.trigger?.name ?? null,
    triggerPresent: t.trigger ? triggers.some((r) => r.name === t.trigger?.name) : null,
    jobQueueRows: t.jobQueueEntityType
      ? queue.find((q) => q.entityType === t.jobQueueEntityType)?.count ?? 0
      : null,
  }));
}
