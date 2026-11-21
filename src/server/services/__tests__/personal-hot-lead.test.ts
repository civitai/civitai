import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listRecentlyVersionedModels } from '@civitai/db-queries/model';
import { redisMock } from '~/__tests__/mocks';
import { pgliteKysely } from '~/__tests__/pglite-kysely';

// The guard's contract, without its env-driven deadline and breaker: a failed read is the fallback.
vi.mock('~/server/redis/cluster-cache-guard', () => ({
  clusterCacheGuard: {
    call: (_: string, op: () => Promise<unknown>) => op(),
    readOr: (_: string, op: () => Promise<unknown>, fallback: unknown) =>
      op().catch(() => fallback),
    writeBestEffort: (_: string, op: () => Promise<unknown>) =>
      op().then(
        () => true,
        () => false
      ),
  },
}));

import {
  getPersonalLeadModelIds,
  pickPersonalLead,
  type PersonalLeadCandidate,
} from '~/server/services/model.service';

const VIEWER = 1;
const PG = 1;
const R = 4;
const now = Date.now();
const day = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(now - days * day);

const candidate = (c: Partial<PersonalLeadCandidate> & { modelId: number; userId: number }) => ({
  hotScore: 0,
  versionPublishedAt: ago(1),
  versionNsfwLevel: PG,
  ...c,
});
const pick = (args: Partial<Parameters<typeof pickPersonalLead>[0]>) =>
  pickPersonalLead({
    viewerId: VIEWER,
    browsingLevel: PG,
    stake: [],
    follows: [],
    hiddenModelIds: new Set(),
    hiddenUserIds: new Set(),
    candidates: [],
    ...args,
  }).ids;

describe('pickPersonalLead', () => {
  it('leads with a liked model whose new version came out after the like, even with no engagement yet', () => {
    expect(
      pick({
        stake: [{ modelId: 10, userId: 50, touchedAt: ago(5) }],
        candidates: [
          candidate({ modelId: 10, userId: 50, hotScore: null, versionPublishedAt: ago(1) }),
        ],
      })
    ).toEqual([10]);
  });

  it('skips a liked model whose newest version predates the like', () => {
    expect(
      pick({
        stake: [{ modelId: 10, userId: 50, touchedAt: ago(1) }],
        candidates: [candidate({ modelId: 10, userId: 50, versionPublishedAt: ago(3) })],
      })
    ).toEqual([]);
  });

  it('puts the stake arm before the creator arm, Hot order within each, and gives a creator one creator-arm slot', () => {
    expect(
      pick({
        stake: [
          { modelId: 10, userId: 50, touchedAt: ago(9) },
          { modelId: 11, userId: 50, touchedAt: ago(9) },
        ],
        follows: [60],
        candidates: [
          candidate({ modelId: 20, userId: 60, hotScore: 900 }),
          candidate({ modelId: 21, userId: 60, hotScore: 800 }),
          candidate({ modelId: 22, userId: 50, hotScore: 700 }), // a stake model's creator
          candidate({ modelId: 10, userId: 50, hotScore: 1 }),
          candidate({ modelId: 11, userId: 50, hotScore: 2 }),
        ],
      })
    ).toEqual([11, 10, 20, 22]);
  });

  it('drops muted, hidden, blocked, own and over-level models', () => {
    expect(
      pick({
        stake: [
          { modelId: 10, userId: 50, touchedAt: ago(9) },
          { modelId: 11, userId: 51, touchedAt: ago(9), muted: true },
        ],
        follows: [60, 61, VIEWER],
        hiddenModelIds: new Set([20]),
        hiddenUserIds: new Set([61]),
        candidates: [
          candidate({ modelId: 10, userId: 50, versionNsfwLevel: R }), // over the viewer's level
          candidate({ modelId: 11, userId: 51 }), // muted
          candidate({ modelId: 20, userId: 60 }), // hidden model
          candidate({ modelId: 21, userId: 61 }), // hidden or blocked creator
          candidate({ modelId: 22, userId: VIEWER }), // their own
          candidate({ modelId: 23, userId: 60 }),
        ],
      })
    ).toEqual([23]);
  });

  it('caps the lead at k', () => {
    const stake = Array.from({ length: 9 }, (_, i) => ({
      modelId: i + 1,
      userId: 50,
      touchedAt: ago(9),
    }));
    const candidates = stake.map((s) => candidate({ modelId: s.modelId, userId: 50 }));
    expect(pick({ stake, candidates, k: 6 })).toHaveLength(6);
  });
});

describe('getPersonalLeadModelIds', () => {
  const args = { userId: VIEWER, browsingLevel: PG, firstPage: true };
  const lead = { ids: [10], stakeArm: 1, creatorArm: 0 };
  const packedGet = redisMock.redis.packed.get;
  const packedSet = redisMock.redis.packed.set;
  beforeEach(() => {
    packedGet.mockReset();
    packedSet.mockReset().mockResolvedValue('OK');
  });

  it('serves no lead and computes nothing when the Redis read fails', async () => {
    packedGet.mockRejectedValue(new Error('cluster down'));
    const compute = vi.fn().mockResolvedValue(lead);
    expect(await getPersonalLeadModelIds(args, compute)).toEqual([]);
    expect(compute).not.toHaveBeenCalled();
    expect(packedSet).not.toHaveBeenCalled();
  });

  it('serves the cached lead on any page', async () => {
    packedGet.mockResolvedValue([10, 11]);
    const compute = vi.fn();
    expect(await getPersonalLeadModelIds({ ...args, firstPage: false }, compute)).toEqual([10, 11]);
    expect(compute).not.toHaveBeenCalled();
  });

  it('computes only on page 1: a miss on a later page excludes nothing', async () => {
    packedGet.mockResolvedValue(null);
    const compute = vi.fn().mockResolvedValue(lead);
    expect(await getPersonalLeadModelIds({ ...args, firstPage: false }, compute)).toEqual([]);
    expect(compute).not.toHaveBeenCalled();
  });

  it('caches and returns a lead computed within the budget', async () => {
    packedGet.mockResolvedValue(null);
    expect(await getPersonalLeadModelIds(args, vi.fn().mockResolvedValue(lead))).toEqual([10]);
    expect(packedSet).toHaveBeenCalledWith(
      `packed:caches:personal-hot-lead:${VIEWER}:${PG}`,
      [10],
      {
        EX: 3600,
      }
    );
  });

  it('past the budget, serves no lead and caches an empty one, so page 2 hides nothing', async () => {
    packedGet.mockResolvedValue(null);
    const slow = vi.fn(
      () => new Promise<typeof lead>((resolve) => setTimeout(() => resolve(lead), 1000))
    );
    expect(await getPersonalLeadModelIds(args, slow)).toEqual([]);
    expect(packedSet).toHaveBeenCalledWith(expect.any(String), [], { EX: 3600 });
  });

  it('writes nothing when the candidate list is not ready', async () => {
    packedGet.mockResolvedValue(null);
    expect(
      await getPersonalLeadModelIds(args, vi.fn().mockResolvedValue('no-candidates' as const))
    ).toEqual([]);
    expect(packedSet).not.toHaveBeenCalled();
  });
});

// The version rules run as SQL, against real tables.
describe('listRecentlyVersionedModels', () => {
  let pg: PGlite;
  vi.setConfig({ hookTimeout: 60_000 });
  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE "ModelMetric" (
        "modelId" int PRIMARY KEY, "userId" int NOT NULL, status text NOT NULL,
        "lastVersionAt" timestamp(3), "hotScore" int
      );
      CREATE TABLE "ModelVersion" (
        id int PRIMARY KEY, "modelId" int NOT NULL, status text NOT NULL, availability text NOT NULL,
        "publishedAt" timestamp(3), "initialPublishedAt" timestamp(3), "nsfwLevel" int NOT NULL
      );
    `);
  });
  afterAll(() => pg.close());

  it('keeps Published Public and EarlyAccess versions inside the window, newest per model, and drops re-dates', async () => {
    const t = (days: number) => ago(days).toISOString();
    await pg.exec(`
      INSERT INTO "ModelMetric" VALUES
        (1, 50, 'Published', '${t(1)}', 100),
        (2, 51, 'Published', '${t(1)}', 200),
        (3, 52, 'Published', '${t(1)}', 300),
        (4, 53, 'Published', '${t(1)}', 400),
        (5, 54, 'Unpublished', '${t(1)}', 500),
        (6, 55, 'Published', '${t(30)}', 600);
      INSERT INTO "ModelVersion" VALUES
        (101, 1, 'Published', 'Public', '${t(1)}', '${t(1)}', 1),
        (102, 1, 'Published', 'Public', '${t(3)}', '${t(3)}', 1),
        (201, 2, 'Published', 'EarlyAccess', '${t(2)}', '${t(2)}', 1),
        (301, 3, 'Published', 'Private', '${t(2)}', '${t(2)}', 1),
        (401, 4, 'Published', 'Public', '${t(2)}', '${t(200)}', 1),
        (501, 5, 'Published', 'Public', '${t(2)}', '${t(2)}', 1),
        (601, 6, 'Published', 'Public', '${t(30)}', '${t(30)}', 1);
    `);
    const rows = await listRecentlyVersionedModels(
      pgliteKysely(() => pg),
      { since: ago(14) }
    );
    expect(rows.map((r) => r.modelId)).toEqual([1, 2]);
    expect(new Date(rows[0].versionPublishedAt!).getTime()).toBeGreaterThan(ago(2).getTime());
  });
});
