import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * BlockRegistry.getSlotReservation reuses listForModel verbatim and folds the
 * result through computeSlotReservation. We don't hit a DB here — we stub
 * listForModel (the indexed/cached path is exercised by its own tests) and
 * assert the reservation fold + the "no extra query" reuse.
 */

const { mockDbRead, mockDbWrite, mockRedis, mockSysRedis } = vi.hoisted(() => {
  const dbRead = {
    $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    modelVersion: { findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []) },
  };
  const dbWrite = {};
  const redis = {
    packed: { get: vi.fn(async () => null), set: vi.fn(async () => undefined) },
    del: vi.fn(async () => 0),
    scanIterator: async function* () {},
  };
  const sysRedis = { sMembers: vi.fn(async () => []) };
  return { mockDbRead: dbRead, mockDbWrite: dbWrite, mockRedis: redis, mockSysRedis: sysRedis };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDbRead, dbWrite: mockDbWrite }));
vi.mock('~/server/redis/client', () => ({
  redis: mockRedis,
  sysRedis: mockSysRedis,
  REDIS_KEYS: { BLOCKS: { REGISTRY: 'packed:caches:block-registry' } },
  REDIS_SYS_KEYS: { BLOCKS: { EMERGENCY_KILL_LIST: 'kill' } },
}));

import { BlockRegistry, CHROME_BAR_PX } from '../block-registry.service';
import type { BlockInstallRecord } from '../block-registry.service';

function record(minHeight: number, renderMode: 'iframe' | 'inline' = 'iframe'): BlockInstallRecord {
  return {
    blockInstanceId: 'bki_x',
    blockId: 'b',
    appId: 'oc',
    appBlockId: 'apb',
    manifest: {
      iframe: {
        src: 'https://block.example/app',
        minHeight,
        maxHeight: null,
        resizable: true,
        sandbox: 'allow-scripts',
      },
    },
    publisherSettings: {},
    enabled: true,
    renderMode,
    trustTier: 'unverified',
  };
}

describe('BlockRegistry.getSlotReservation', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  const opts = { modelId: 1, slotId: 'model.sidebar_top' };

  it('returns {hasInstall:false, reservedHeight:0} when no installs (zero-install no-regression)', async () => {
    const spy = vi.spyOn(BlockRegistry, 'listForModel').mockResolvedValue([]);
    const r = await BlockRegistry.getSlotReservation(opts);
    expect(r).toEqual({ hasInstall: false, reservedHeight: 0 });
    // Reuses listForModel — no separate query shape (no N+1).
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(opts);
  });

  it('reserves max(minHeight)+CHROME_BAR_PX for a single install', async () => {
    vi.spyOn(BlockRegistry, 'listForModel').mockResolvedValue([record(300)]);
    const r = await BlockRegistry.getSlotReservation(opts);
    expect(r).toEqual({ hasInstall: true, reservedHeight: 300 + CHROME_BAR_PX });
  });

  it('reserves the tallest minHeight across multiple installs', async () => {
    vi.spyOn(BlockRegistry, 'listForModel').mockResolvedValue([
      record(200),
      record(480),
      record(360),
    ]);
    const r = await BlockRegistry.getSlotReservation(opts);
    expect(r).toEqual({ hasInstall: true, reservedHeight: 480 + CHROME_BAR_PX });
  });
});
