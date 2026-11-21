import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { listModelStake, listRecentlyVersionedModels } from '@civitai/db-queries/model';
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
  computePersonalLead,
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

  it('drops a muted model even when its creator is followed, and the viewer’s own liked model', () => {
    expect(
      pick({
        stake: [
          { modelId: 11, userId: 60, touchedAt: ago(9), muted: true },
          { modelId: 12, userId: VIEWER, touchedAt: ago(9) },
        ],
        follows: [60],
        candidates: [
          candidate({ modelId: 11, userId: 60 }),
          candidate({ modelId: 12, userId: VIEWER }),
        ],
      })
    ).toEqual([]);
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
    expect(packedSet).toHaveBeenCalledWith(expect.any(String), [], { EX: 60 });
  });

  it('serves no lead and caches nothing when the compute fails', async () => {
    packedGet.mockResolvedValue(null);
    expect(await getPersonalLeadModelIds(args, vi.fn().mockRejectedValue(new Error('db')))).toEqual(
      []
    );
    expect(packedSet).not.toHaveBeenCalled();
  });

  it('writes nothing when the candidate list is not ready', async () => {
    packedGet.mockResolvedValue(null);
    expect(
      await getPersonalLeadModelIds(args, vi.fn().mockResolvedValue('no-candidates' as const))
    ).toEqual([]);
    expect(packedSet).not.toHaveBeenCalled();
  });
});

describe('computePersonalLead', () => {
  it('feeds likes, engagements, follows and hidden lists into the pick', async () => {
    const result = await computePersonalLead(VIEWER, PG, {
      getCandidates: async () => [
        candidate({ modelId: 10, userId: 50 }), // liked
        candidate({ modelId: 11, userId: 51 }), // favourited
        candidate({ modelId: 12, userId: 52 }), // muted
        candidate({ modelId: 20, userId: 60 }), // followed creator
        candidate({ modelId: 21, userId: 61 }), // creator who blocked the viewer
        candidate({ modelId: 22, userId: 62 }), // hidden model
      ],
      listStake: async () => ({
        likes: [{ modelId: 10, userId: 50, touchedAt: ago(9) }],
        engagements: [
          { modelId: 11, userId: 51, type: 'Favorite' as const, touchedAt: ago(9) },
          { modelId: 12, userId: 52, type: 'Mute' as const, touchedAt: ago(9) },
        ],
      }),
      getFollows: async () => [60, 61, 62],
      getHidden: async () => ({
        hiddenModels: [{ id: 22 }],
        hiddenUsers: [],
        blockedUsers: [],
        blockedByUsers: [{ id: 61 }],
      }),
    });
    expect(result !== 'no-candidates' && result.ids.sort()).toEqual([10, 11, 20]);
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
        (6, 55, 'Published', '${t(30)}', 600),
        (7, 56, 'Published', '${t(1)}', 700);
      INSERT INTO "ModelVersion" VALUES
        (101, 1, 'Published', 'Public', '${t(1)}', '${t(1)}', 1),
        (102, 1, 'Published', 'Public', '${t(3)}', '${t(3)}', 1),
        (201, 2, 'Published', 'EarlyAccess', '${t(2)}', '${t(2)}', 1),
        (301, 3, 'Published', 'Private', '${t(2)}', '${t(2)}', 1),
        (401, 4, 'Published', 'Public', '${t(2)}', '${t(200)}', 1),
        (501, 5, 'Published', 'Public', '${t(2)}', '${t(2)}', 1),
        (601, 6, 'Published', 'Public', '${t(30)}', '${t(30)}', 1),
        (103, 1, 'Draft', 'Public', '${t(0.5)}', '${t(0.5)}', 1),
        (701, 7, 'Published', 'Public', '${t(40)}', '${t(40)}', 1);
    `);
    const db = pgliteKysely(() => pg);
    const rows = await listRecentlyVersionedModels(db, { since: ago(14), limit: 10 });
    expect(rows.map((r) => r.modelId)).toEqual([2, 1]);
    // Model 1's pick is 101 (1 day), not the newer Draft 103 (0.5 days) nor the older 102 (3 days).
    const model1 = rows.find((r) => r.modelId === 1)!;
    expect(
      Math.abs(new Date(model1.versionPublishedAt!).getTime() - ago(1).getTime())
    ).toBeLessThan(60_000);

    const capped = await listRecentlyVersionedModels(db, { since: ago(14), limit: 1 });
    expect(capped.map((r) => r.modelId)).toEqual([2]);
  });
});

describe('listModelStake', () => {
  let pg: PGlite;
  beforeAll(async () => {
    pg = new PGlite();
    await pg.exec(`
      CREATE TABLE "Model" (id int PRIMARY KEY, "userId" int NOT NULL);
      CREATE TABLE "ResourceReview" (
        "modelId" int NOT NULL, "userId" int NOT NULL, recommended boolean NOT NULL,
        exclude boolean NOT NULL, "tosViolation" boolean NOT NULL, "createdAt" timestamp(3) NOT NULL
      );
      CREATE TABLE "ModelEngagement" (
        "userId" int NOT NULL, "modelId" int NOT NULL, type text NOT NULL, "createdAt" timestamp(3) NOT NULL
      );
      INSERT INTO "Model" VALUES (1, 50), (2, 51), (3, 52), (4, 53), (5, 54), (6, 55);
      INSERT INTO "ResourceReview" VALUES
        (1, 9, true, false, false, now()),
        (2, 9, false, false, false, now()),
        (3, 9, true, true, false, now()),
        (4, 9, true, false, true, now());
      INSERT INTO "ModelEngagement" VALUES
        (9, 5, 'Mute', now() - interval '30 days'),
        (9, 6, 'Favorite', now()),
        (9, 2, 'Notify', now() - interval '5 days'),
        (9, 1, 'Notify', now() - interval '1 day');
    `);
  });
  afterAll(() => pg.close());

  it('reads thumbs-up likes only, keeps the newest Notify under the cap, and keeps every Mute', async () => {
    const db = pgliteKysely(() => pg);
    const { likes } = await listModelStake(db, { userId: 9, limit: 10 });
    expect(likes.map((l) => [l.modelId, l.userId])).toEqual([[1, 50]]);
    const { engagements } = await listModelStake(db, { userId: 9, limit: 1 });
    const ofType = (type: string) =>
      engagements.filter((e) => e.type === type).map((e) => e.modelId);
    expect(ofType('Favorite')).toEqual([6]);
    expect(ofType('Notify')).toEqual([1]); // the older Notify is stored first, so only ORDER BY keeps 1
    expect(ofType('Mute')).toEqual([5]);
  });
});
