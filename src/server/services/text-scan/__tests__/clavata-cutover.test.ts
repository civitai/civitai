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
  UNMODERATED_OVERRIDE,
} = await import('~/server/services/text-scan/clavata-cutover');
const { getTextScanMode } = await import('~/server/services/text-scan/mode');

const BASE = REDIS_SYS_KEYS.ENTITY_MODERATION.BASE;
const ENTITIES = REDIS_SYS_KEYS.ENTITY_MODERATION.KEYS.ENTITIES;
const MIGRATIONS = join(process.cwd(), 'packages/civitai-db-schema/prisma/migrations');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dbMock.dbRead.post.findMany).mockResolvedValue([{ id: 3 }, { id: 2 }] as never);
  vi.mocked(dbMock.dbRead.chatMessage.findMany).mockResolvedValue([{ id: 7 }] as never);
  vi.mocked(redisMock.sysRedis.hGet).mockResolvedValue(JSON.stringify({ Comment: false }) as never);
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

  it('Collection is a normal cutover entity: probed, no unmoderated override', () => {
    expect(UNMODERATED_OVERRIDE.has('Collection')).toBe(false);
    expect(CLAVATA_TARGETS.Collection.recentIds).not.toBeNull();
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
  it('refuses unless every probed id is active', async () => {
    vi.mocked(getTextScanMode).mockImplementation(async (_t, id) =>
      id === 2 ? 'shadow' : 'active'
    );
    await expect(disableClavataFor('Post')).rejects.toMatchObject({
      reason: 'not-active',
      notActive: [2],
      code: 'CONFLICT',
    });
    expect(redisMock.sysRedis.hSet).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses when there is nothing to probe', async () => {
    vi.mocked(dbMock.dbRead.post.findMany).mockResolvedValue([] as never);
    await expect(disableClavataFor('Post')).rejects.toMatchObject({ reason: 'nothing-to-probe' });
    expect(redisMock.sysRedis.hSet).not.toHaveBeenCalled();
  });

  it('refuses the override outside ChatMessage', async () => {
    await expect(disableClavataFor('Post', { allowUnmoderated: true })).rejects.toBeInstanceOf(
      ClavataCutoverRefused
    );
    await expect(disableClavataFor('Post', { allowUnmoderated: true })).rejects.toMatchObject({
      reason: 'override-not-allowed',
    });
    expect(getTextScanMode).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.hSet).not.toHaveBeenCalled();
  });

  it('refuses the override for Collection', async () => {
    await expect(disableClavataFor('Collection', { allowUnmoderated: true })).rejects.toMatchObject(
      { reason: 'override-not-allowed' }
    );
    expect(redisMock.sysRedis.hSet).not.toHaveBeenCalled();
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

  it('disables the key, keeps other overrides, and drains the lane', async () => {
    vi.mocked(getTextScanMode).mockResolvedValue('active');
    vi.mocked(dbMock.dbWrite.$executeRaw).mockResolvedValueOnce(12 as never);
    const result = await disableClavataFor('Post');
    expect(redisMock.sysRedis.hSet).toHaveBeenCalledWith(
      BASE,
      ENTITIES,
      JSON.stringify({ Comment: false, Post: false })
    );
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
    expect(redisMock.sysRedis.hSet).toHaveBeenCalledWith(
      BASE,
      ENTITIES,
      JSON.stringify({ Comment: false, Chat: false })
    );
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
    expect(redisMock.sysRedis.hSet).toHaveBeenCalledWith(
      BASE,
      ENTITIES,
      JSON.stringify({ Comment: false, Collection: false })
    );
    expect(result).toMatchObject({
      clavataKey: 'Collection',
      drain: { deleted: 3, complete: true },
    });
  });
});

describe('enableClavataFor', () => {
  it('removes the override without probing the flag', async () => {
    const result = await enableClavataFor('Comment');
    expect(getTextScanMode).not.toHaveBeenCalled();
    expect(redisMock.sysRedis.hSet).toHaveBeenCalledWith(BASE, ENTITIES, JSON.stringify({}));
    expect(result.entities).toEqual({});
  });
});

describe('getClavataCutoverStatus', () => {
  it('reports each target against the override, the live triggers and the queue', async () => {
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
