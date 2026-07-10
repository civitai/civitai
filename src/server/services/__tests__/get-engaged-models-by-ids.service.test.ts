import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PR1 of the `user.getEngagedModels` freeze-fix — the additive, per-visible-set membership
 * service `getUserEngagedModelsByIds`, plus the `modelIds` extension of the shared
 * `getResourceReviewsByUserId` it reuses for the `Recommended` source.
 *
 * The bug it replaces: the unbounded `getUserEngagedModels` handler serializes a whale's ENTIRE
 * engagement history (3.75 MB / 482 ms synchronous serialize → 6 s api-primary event-loop freeze).
 * These tests pin that the new path returns ONLY the intersection of (user's engagements ∩ input
 * modelIds), keyed by engagement type, so the response is bounded by |modelIds| × (#types).
 *
 * `~/server/db/client` is mocked with an in-memory fixture whose `findMany` applies the real
 * `where` clause — so the tests exercise the service's shaping AND that it passes the correct,
 * bounded filters down to Prisma (including through the reused `getResourceReviewsByUserId`).
 */

// Model id fixtures (kept in sync with the hoisted mock below — plain numbers, safe to duplicate).
const USER = 1;
const OTHER_USER = 2;
const A = 101; // Favorite + Recommended
const B = 102; // Hide + Notify
const C = 103; // Favorite (OUTSIDE the typical input set)
const D = 104; // Mute (outside input)
const E = 105; // Recommended only (outside input)
const F = 106; // resource review but recommended:false (must never appear)
const Z = 999; // in input but user has NO engagement

const { mockDb } = vi.hoisted(() => {
  const U = 1;
  const OU = 2;
  type EngRow = { userId: number; modelId: number; type: string };
  type RevRow = { userId: number; modelId: number; modelVersionId: number; recommended: boolean };

  const engagementRows: EngRow[] = [
    { userId: U, modelId: 101, type: 'Favorite' },
    { userId: U, modelId: 102, type: 'Hide' },
    { userId: U, modelId: 102, type: 'Notify' },
    { userId: U, modelId: 103, type: 'Favorite' },
    { userId: U, modelId: 104, type: 'Mute' },
    { userId: OU, modelId: 101, type: 'Favorite' }, // isolation: must never leak into U's result
    { userId: OU, modelId: 102, type: 'Hide' },
  ];
  const reviewRows: RevRow[] = [
    { userId: U, modelId: 101, modelVersionId: 1001, recommended: true },
    { userId: U, modelId: 105, modelVersionId: 1002, recommended: true },
    { userId: U, modelId: 106, modelVersionId: 1003, recommended: false },
    { userId: OU, modelId: 101, modelVersionId: 1004, recommended: true },
  ];

  const inArr = (where: any, field: string) => where?.[field]?.in as number[] | undefined;

  return {
    mockDb: {
      modelEngagement: {
        findMany: vi.fn(async ({ where }: any) => {
          const ids = inArr(where, 'modelId');
          return engagementRows
            .filter(
              (r) =>
                r.userId === where.userId &&
                (where.type === undefined || r.type === where.type) &&
                (!ids || ids.includes(r.modelId))
            )
            .map((r) => ({ modelId: r.modelId, type: r.type }));
        }),
      },
      resourceReview: {
        findMany: vi.fn(async ({ where }: any) => {
          const ids = inArr(where, 'modelId');
          return reviewRows
            .filter(
              (r) =>
                r.userId === where.userId &&
                (where.recommended === undefined || r.recommended === where.recommended) &&
                (!ids || ids.includes(r.modelId))
            )
            .map((r) => ({ modelId: r.modelId, modelVersionId: r.modelVersionId }));
        }),
      },
    },
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
// user.service reaches into user-preferences.service at import time; stub the surface
// (matches the proven recipe in engagement-toggle.idempotent.service.test.ts).
vi.mock('~/server/services/user-preferences.service', () => ({
  HiddenModels: { refreshCache: vi.fn(async () => undefined) },
  HiddenModels3D: { refreshCache: vi.fn(async () => undefined) },
  HiddenUsers: { refreshCache: vi.fn(async () => undefined) },
  HiddenImages: { refreshCache: vi.fn(async () => undefined) },
  HiddenTags: { refreshCache: vi.fn(async () => undefined) },
  BlockedUsers: { refreshCache: vi.fn(async () => undefined), getCached: vi.fn(async () => []) },
  BlockedByUsers: { refreshCache: vi.fn(async () => undefined) },
  ImplicitHiddenImages: { refreshCache: vi.fn(async () => undefined) },
  toggleHidden: vi.fn(async () => ({ added: [], removed: [] })),
}));

import { getUserEngagedModelsByIds } from '~/server/services/user.service';
import { getResourceReviewsByUserId } from '~/server/services/resourceReview.service';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getUserEngagedModelsByIds — shape', () => {
  it('returns a Record keyed by engagement type + Recommended', async () => {
    const res = await getUserEngagedModelsByIds({ id: USER, modelIds: [A, B, C, D] });
    // All the user's real engagement types (over the input) are present.
    expect(res.Favorite).toEqual(expect.arrayContaining([A, C]));
    expect(res.Hide).toEqual([B]);
    expect(res.Notify).toEqual([B]);
    expect(res.Mute).toEqual([D]);
    expect(res.Recommended).toBeDefined();
  });
});

describe('getUserEngagedModelsByIds — membership is scoped to (engagements ∩ input)', () => {
  it('includes only ids that are BOTH engaged AND in the input set', async () => {
    const res = await getUserEngagedModelsByIds({ id: USER, modelIds: [A, B, Z] });

    // A/B are engaged AND in input.
    expect(res.Favorite).toEqual([A]);
    expect(res.Hide).toEqual([B]);
    expect(res.Notify).toEqual([B]);

    // C is engaged but NOT in input → appears nowhere.
    const allIds = Object.values(res).flat();
    expect(allIds).not.toContain(C);
    // D (Mute, not in input) also absent.
    expect(allIds).not.toContain(D);
    // Z is in input but not engaged → appears in NO array.
    expect(allIds).not.toContain(Z);
  });

  it('passes the bounded modelId filter down to Prisma (both tables)', async () => {
    await getUserEngagedModelsByIds({ id: USER, modelIds: [A, B, Z] });
    expect(mockDb.modelEngagement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER, modelId: { in: [A, B, Z] } } })
    );
    expect(mockDb.resourceReview.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER, recommended: true, modelId: { in: [A, B, Z] } },
      })
    );
  });
});

describe('getUserEngagedModelsByIds — per-type correctness', () => {
  it('a Hide model shows under Hide and not under Favorite', async () => {
    const res = await getUserEngagedModelsByIds({ id: USER, modelIds: [B] });
    expect(res.Hide).toContain(B);
    expect(res.Favorite ?? []).not.toContain(B);
  });

  it('a model engaged as multiple types appears under each type', async () => {
    const res = await getUserEngagedModelsByIds({ id: USER, modelIds: [B] });
    expect(res.Hide).toContain(B);
    expect(res.Notify).toContain(B);
  });
});

describe('getUserEngagedModelsByIds — Recommended path', () => {
  it('a recommended model in the input set appears under Recommended', async () => {
    const res = await getUserEngagedModelsByIds({ id: USER, modelIds: [A] });
    expect(res.Recommended).toEqual([A]);
  });

  it('a recommended model OUTSIDE the input set does not appear', async () => {
    const res = await getUserEngagedModelsByIds({ id: USER, modelIds: [A, B] });
    expect(res.Recommended).not.toContain(E);
    expect(res.Recommended).toEqual([A]);
  });

  it('a non-recommended review (recommended:false) never appears', async () => {
    const res = await getUserEngagedModelsByIds({ id: USER, modelIds: [A, F] });
    expect(res.Recommended).not.toContain(F);
  });
});

describe('getUserEngagedModelsByIds — user isolation', () => {
  it("does not return another user's engagements on the same modelIds", async () => {
    const res = await getUserEngagedModelsByIds({ id: USER, modelIds: [A, B] });
    // OTHER_USER also has A/B engagements, but querying USER must only reflect USER's rows.
    expect(res.Favorite).toEqual([A]); // A once (USER's), not doubled by OTHER_USER
    expect(res.Hide).toEqual([B]);
  });

  it("querying the other user returns only that user's engagements", async () => {
    const res = await getUserEngagedModelsByIds({ id: OTHER_USER, modelIds: [A, B] });
    expect(res.Favorite).toEqual([A]);
    expect(res.Hide).toEqual([B]);
    expect(res.Notify ?? []).not.toContain(B); // OTHER_USER has no Notify
    expect(res.Recommended).toEqual([A]); // OTHER_USER's own recommended review on A
  });
});

describe('getUserEngagedModelsByIds — edge cases', () => {
  it('empty result: user has none of the input ids → Recommended empty, no crash', async () => {
    const res = await getUserEngagedModelsByIds({ id: USER, modelIds: [Z] });
    expect(res.Recommended).toEqual([]);
    // No engagement-type keys created for an absent id.
    expect(Object.values(res).flat()).toEqual([]);
  });

  it('duplicate ids in the input do not duplicate output', async () => {
    const res = await getUserEngagedModelsByIds({ id: USER, modelIds: [A, A, B] });
    expect(res.Favorite).toEqual([A]);
    expect(res.Hide).toEqual([B]);
  });
});

describe('getUserEngagedModelsByIds — freeze-safety bound', () => {
  it('200 ids all engaged across every type yields a bounded result (≤ ~1000 ids)', async () => {
    const modelIds = Array.from({ length: 200 }, (_, i) => 5000 + i);
    const types = ['Favorite', 'Hide', 'Notify', 'Mute'];
    const bigEng = modelIds.flatMap((modelId) => types.map((type) => ({ modelId, type })));
    const bigRev = modelIds.map((modelId, i) => ({ modelId, modelVersionId: 9000 + i }));

    mockDb.modelEngagement.findMany.mockImplementationOnce(async ({ where }: any) => {
      const ids = where.modelId.in as number[];
      return bigEng.filter((r) => ids.includes(r.modelId));
    });
    mockDb.resourceReview.findMany.mockImplementationOnce(async ({ where }: any) => {
      const ids = where.modelId.in as number[];
      return bigRev.filter((r) => ids.includes(r.modelId));
    });

    const res = await getUserEngagedModelsByIds({ id: USER, modelIds });
    const total = Object.values(res).reduce((n, arr) => n + arr.length, 0);
    // 200 × 4 engagement types + 200 recommended = 1000. Bounded by input, not history.
    expect(total).toBe(1000);
    expect(total).toBeLessThanOrEqual(1000);
  });
});

describe('getResourceReviewsByUserId — modelIds extension (backward-compatible)', () => {
  it('default (no modelIds) omits the modelId filter — preserves whole-history behavior', async () => {
    await getResourceReviewsByUserId({ userId: USER, recommended: true });
    const call = mockDb.resourceReview.findMany.mock.calls.at(-1)?.[0];
    expect(call.where).toEqual({ userId: USER, recommended: true });
    expect(call.where).not.toHaveProperty('modelId');
  });

  it('with modelIds adds a bounded modelId: { in } filter', async () => {
    await getResourceReviewsByUserId({ userId: USER, recommended: true, modelIds: [A, E] });
    const call = mockDb.resourceReview.findMany.mock.calls.at(-1)?.[0];
    expect(call.where).toEqual({ userId: USER, recommended: true, modelId: { in: [A, E] } });
  });

  it('filters the returned rows to the input set when modelIds is passed', async () => {
    const rows = await getResourceReviewsByUserId({
      userId: USER,
      recommended: true,
      modelIds: [A],
    });
    expect(rows.map((r) => r.modelId)).toEqual([A]);
  });
});
