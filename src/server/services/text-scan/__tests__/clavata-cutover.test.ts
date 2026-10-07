import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { REDIS_SYS_KEYS } from '~/server/redis/client';
import type * as ModeModule from '~/server/services/text-scan/mode';

vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(),
  isTextScanEnabled: vi.fn(),
  readTextScanRollouts: vi.fn(),
}));

const {
  CLAVATA_TARGETS,
  ClavataCutoverRefused,
  DRAIN_BATCH,
  DRAIN_MAX_BATCHES,
  disableClavataFor,
  drainModerationQueue,
  enableClavataFor,
  getClavataCutoverStatus,
  getTextScanOwnedClavataKeys,
  UNMODERATED_OVERRIDE,
} = await import('~/server/services/text-scan/clavata-cutover');
const { getTextScanMode, isTextScanEnabled, readTextScanRollouts } = await import(
  '~/server/services/text-scan/mode'
);

const CUTOVER = REDIS_SYS_KEYS.TEXT_SCAN.CLAVATA_CUTOVER;
const MIGRATIONS = join(process.cwd(), 'packages/civitai-db-schema/prisma/migrations');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dbMock.dbRead.post.findMany).mockResolvedValue([{ id: 3 }, { id: 2 }] as never);
  vi.mocked(dbMock.dbRead.chatMessage.findMany).mockResolvedValue([{ id: 7 }] as never);
  vi.mocked(redisMock.sysRedis.hGet).mockResolvedValue(JSON.stringify({ Comment: false }) as never);
  vi.mocked(isTextScanEnabled).mockResolvedValue(true);
  const full = { shadow: 0, active: 100 };
  vi.mocked(readTextScanRollouts).mockResolvedValue({
    Post: full,
    ChatMessage: full,
    Collection: full,
  });
});

describe('CLAVATA_TARGETS', () => {
  it('maps ChatMessage to the Chat key with no trigger and no JobQueue lane', () => {
    expect(CLAVATA_TARGETS.ChatMessage).toMatchObject({
      clavataKey: 'Chat',
      jobQueueEntityType: null,
      trigger: null,
    });
  });

  it('names every other trigger after its Clavata key', () => {
    for (const [entityType, t] of Object.entries(CLAVATA_TARGETS)) {
      if (entityType === 'ChatMessage') continue;
      expect(t.clavataKey).toBe(entityType);
      expect(t.jobQueueEntityType).toBe(entityType);
      expect(t.trigger).toEqual({
        name: `trg_moderation_${entityType.toLowerCase()}`,
        table: entityType,
      });
    }
    expect(Object.keys(CLAVATA_TARGETS)).toHaveLength(12);
    expect(Object.hasOwn(CLAVATA_TARGETS, 'Challenge')).toBe(false);
  });

  it('Collection is a normal cutover entity: no unmoderated override', () => {
    expect(UNMODERATED_OVERRIDE.has('Collection')).toBe(false);
  });

  // The drops run by hand at each entity's cutover. As migrations, an "apply every pending
  // migration" pass before release would remove Clavata while text scan is still off.
  it('no migration drops a Clavata trigger', () => {
    const triggers = Object.values(CLAVATA_TARGETS).flatMap((t) =>
      t.trigger ? [t.trigger.name] : []
    );
    expect(triggers).toHaveLength(11);
    const offenders = readdirSync(MIGRATIONS).filter((dir) => {
      let sql: string;
      try {
        sql = readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
      } catch {
        return false;
      }
      const live = sql
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n');
      return triggers.some((name) =>
        new RegExp(`DROP\\s+TRIGGER[^;]*\\b${name}\\b`, 'i').test(live)
      );
    });
    expect(offenders).toEqual([]);
  });
});

describe('disableClavataFor', () => {
  it.each([
    ['the kill switch is off', false, { Post: { shadow: 0, active: 100 } }],
    ['the entity type is below 100% active', true, { Post: { shadow: 100, active: 90 } }],
    ['the entity type has no rollout', true, {}],
  ])('refuses before probing or draining when %s', async (_why, on, rollouts) => {
    vi.mocked(isTextScanEnabled).mockResolvedValue(on);
    vi.mocked(readTextScanRollouts).mockResolvedValue(rollouts);
    vi.mocked(getTextScanMode).mockResolvedValue('active');
    await expect(disableClavataFor('Post')).rejects.toMatchObject({ reason: 'not-fully-active' });
    expect(getTextScanMode).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.sAdd).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses unless every probed id is active', async () => {
    vi.mocked(getTextScanMode).mockImplementation(async (_t, id) =>
      id === 2 ? 'shadow' : 'active'
    );
    await expect(disableClavataFor('Post')).rejects.toMatchObject({
      reason: 'not-active',
      notActive: [2],
      code: 'CONFLICT',
    });
    expect(redisMock.sysRedis.sAdd).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses when there is nothing to probe', async () => {
    vi.mocked(dbMock.dbRead.post.findMany).mockResolvedValue([] as never);
    await expect(disableClavataFor('Post')).rejects.toMatchObject({ reason: 'nothing-to-probe' });
    expect(redisMock.sysRedis.sAdd).not.toHaveBeenCalled();
  });

  it('refuses the override outside ChatMessage', async () => {
    await expect(disableClavataFor('Post', { allowUnmoderated: true })).rejects.toBeInstanceOf(
      ClavataCutoverRefused
    );
    await expect(disableClavataFor('Post', { allowUnmoderated: true })).rejects.toMatchObject({
      reason: 'override-not-allowed',
    });
    expect(getTextScanMode).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.sAdd).not.toHaveBeenCalled();
  });

  it('refuses the override for Collection', async () => {
    await expect(disableClavataFor('Collection', { allowUnmoderated: true })).rejects.toMatchObject(
      { reason: 'override-not-allowed' }
    );
    expect(redisMock.sysRedis.sAdd).not.toHaveBeenCalled();
  });

  it('probes only public collections readable as Public or Unlisted', async () => {
    vi.mocked(dbMock.dbRead.collection.findMany).mockResolvedValue([{ id: 9 }] as never);
    vi.mocked(getTextScanMode).mockResolvedValue('active');
    await disableClavataFor('Collection');
    expect(dbMock.dbRead.collection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { availability: 'Public', read: { in: ['Public', 'Unlisted'] } },
      })
    );
    expect(getTextScanMode).toHaveBeenCalledWith('Collection', 9);
  });

  it('adds the key to the cutover set, leaves the operator toggles alone, and drains the lane', async () => {
    vi.mocked(getTextScanMode).mockResolvedValue('active');
    vi.mocked(dbMock.dbWrite.$executeRaw).mockResolvedValueOnce(12 as never);
    const result = await disableClavataFor('Post');
    expect(redisMock.sysRedis.sAdd).toHaveBeenCalledWith(CUTOVER, 'Post');
    expect(redisMock.sysRedis.hSet).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      clavataKey: 'Post',
      probed: 2,
      unmoderatedOverride: false,
      drain: { deleted: 12, complete: true },
    });
  });

  it('disables Chat without touching JobQueue', async () => {
    vi.mocked(getTextScanMode).mockResolvedValue('active');
    const result = await disableClavataFor('ChatMessage');
    expect(redisMock.sysRedis.sAdd).toHaveBeenCalledWith(CUTOVER, 'Chat');
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
    expect(result.drain).toBeNull();
  });

  it('switches Chat off with the override while text-scan is not active, and logs it', async () => {
    vi.mocked(getTextScanMode).mockResolvedValue('shadow');
    const result = await disableClavataFor('ChatMessage', { allowUnmoderated: true });
    expect(getTextScanMode).not.toHaveBeenCalled();
    expect(result).toMatchObject({ clavataKey: 'Chat', probed: 0, unmoderatedOverride: true });
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'text-scan-clavata-cutover',
        type: 'warning',
        entityType: 'ChatMessage',
      })
    );
  });

  it('retires Collection once its probe is active and drains its lane', async () => {
    vi.mocked(dbMock.dbRead.collection.findMany).mockResolvedValue([{ id: 9 }] as never);
    vi.mocked(getTextScanMode).mockResolvedValue('active');
    vi.mocked(dbMock.dbWrite.$executeRaw).mockResolvedValueOnce(3 as never);
    const result = await disableClavataFor('Collection');
    expect(redisMock.sysRedis.sAdd).toHaveBeenCalledWith(CUTOVER, 'Collection');
    expect(result).toMatchObject({
      clavataKey: 'Collection',
      drain: { deleted: 3, complete: true },
    });
  });
});

describe('enableClavataFor', () => {
  it('removes the key from the cutover set without probing the mode', async () => {
    vi.mocked(redisMock.sysRedis.sMembers).mockResolvedValue(['Post'] as never);
    const result = await enableClavataFor('Comment');
    expect(getTextScanMode).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.sRem).toHaveBeenCalledWith(CUTOVER, 'Comment');
    expect(redisMock.sysRedis.hSet).not.toHaveBeenCalled();
    expect(result.cutover).toEqual(['Post']);
  });
});

describe('getClavataCutoverStatus', () => {
  it('reports each target against the override, the live triggers and the queue', async () => {
    vi.mocked(redisMock.sysRedis.sMembers).mockResolvedValue([] as never);
    vi.mocked(isTextScanEnabled).mockResolvedValue(true);
    vi.mocked(dbMock.dbRead.$queryRaw)
      .mockResolvedValueOnce([{ name: 'trg_moderation_post' }] as never)
      .mockResolvedValueOnce([{ entityType: 'Post', count: 4 }] as never);
    const rows = await getClavataCutoverStatus();
    expect(rows.find((r) => r.entityType === 'Comment')).toMatchObject({
      clavataDisabled: true,
      triggerPresent: false,
      jobQueueRows: 0,
    });
    expect(rows.find((r) => r.entityType === 'Post')).toMatchObject({
      clavataDisabled: false,
      triggerPresent: true,
      jobQueueRows: 4,
    });
    expect(rows.find((r) => r.entityType === 'ChatMessage')).toMatchObject({
      trigger: null,
      triggerPresent: null,
      jobQueueRows: null,
    });
  });

  it('reports a cut-over entity as skipped only while text scan owns it', async () => {
    vi.mocked(redisMock.sysRedis.sMembers).mockResolvedValue(['Post'] as never);
    vi.mocked(dbMock.dbRead.$queryRaw).mockResolvedValue([] as never);
    vi.mocked(isTextScanEnabled).mockResolvedValue(true);
    vi.mocked(readTextScanRollouts).mockResolvedValue({ Post: { shadow: 0, active: 100 } });
    expect((await getClavataCutoverStatus()).find((r) => r.entityType === 'Post')).toMatchObject({
      cutOver: true,
      clavataSkipped: true,
    });
    vi.mocked(isTextScanEnabled).mockResolvedValue(false);
    expect((await getClavataCutoverStatus()).find((r) => r.entityType === 'Post')).toMatchObject({
      cutOver: true,
      clavataSkipped: false,
    });
  });
});

describe('getTextScanOwnedClavataKeys', () => {
  beforeEach(() => {
    vi.mocked(redisMock.sysRedis.sMembers).mockResolvedValue(['Comment', 'Chat'] as never);
    vi.mocked(isTextScanEnabled).mockResolvedValue(true);
    vi.mocked(readTextScanRollouts).mockResolvedValue({
      Comment: { shadow: 0, active: 100 },
      ChatMessage: { shadow: 100, active: 100 },
      Post: { shadow: 0, active: 100 },
    });
  });

  it('owns a key only when it is cut over, the switch is on and the type is fully active', async () => {
    // Post is fully active but not cut over; Chat maps to ChatMessage.
    expect(await getTextScanOwnedClavataKeys()).toEqual(new Set(['Comment', 'Chat']));
  });

  it('owns nothing while the kill switch is off', async () => {
    vi.mocked(isTextScanEnabled).mockResolvedValue(false);
    expect(await getTextScanOwnedClavataKeys()).toEqual(new Set());
  });

  it('hands a cut-over key back to Clavata when its rollout drops below 100% active or is removed', async () => {
    vi.mocked(readTextScanRollouts).mockResolvedValue({ Comment: { shadow: 100, active: 99 } });
    expect(await getTextScanOwnedClavataKeys()).toEqual(new Set());
  });

  it('hands every key back to Clavata when the rollout cannot be read', async () => {
    vi.mocked(readTextScanRollouts).mockRejectedValue(new Error('sysRedis down'));
    expect(await getTextScanOwnedClavataKeys()).toEqual(new Set());
  });
});

describe('drainModerationQueue', () => {
  it('stops on a short batch', async () => {
    vi.mocked(dbMock.dbWrite.$executeRaw)
      .mockResolvedValueOnce(DRAIN_BATCH as never)
      .mockResolvedValueOnce(DRAIN_BATCH as never)
      .mockResolvedValueOnce(12 as never);
    expect(await drainModerationQueue('Post')).toEqual({
      deleted: DRAIN_BATCH * 2 + 12,
      complete: true,
    });
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(3);
  });

  it('drain stops at the batch cap', async () => {
    vi.mocked(dbMock.dbWrite.$executeRaw).mockResolvedValue(DRAIN_BATCH as never);
    expect(await drainModerationQueue('Post')).toEqual({
      deleted: DRAIN_BATCH * DRAIN_MAX_BATCHES,
      complete: false,
    });
    expect(dbMock.dbWrite.$executeRaw).toHaveBeenCalledTimes(DRAIN_MAX_BATCHES);
  });
});
