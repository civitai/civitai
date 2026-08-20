import { beforeEach, describe, expect, it, vi } from 'vitest';
// Type-only, so it is erased and does NOT evaluate the module before the
// hoisted `vi.mock` below registers its factory. Keep it `import type`.
import type * as FliptClient from '~/server/flipt/client';

/**
 * THE SEAM: `resolveTestingAccess` decides who is in the `testers` tier of the
 * generation gate rules, and it decides it by handing Flipt an evaluation.
 *
 * The failure this file exists for is invisible from either side alone. The
 * function is obviously correct read on its own — it passes the user's id — and
 * the flag is obviously correct read on its own — it rolls out to `testers`.
 * They disagree about WHERE the id has to be, and the disagreement produces a
 * plain `false`, which is exactly what a genuine non-tester produces.
 *
 * 🔴 A Flipt segment constraint reads ONE of two inputs, and which one is a
 * property of the constraint's TYPE, not of the flag:
 *
 * - `ENTITY_ID_COMPARISON_TYPE` matches the `entityId` ARGUMENT.
 * - `STRING_COMPARISON_TYPE` matches a named property of the evaluation CONTEXT.
 *
 * The live `testers` segment is `ANY_MATCH_TYPE` over two
 * `STRING_COMPARISON_TYPE` constraints (`isModerator eq "true"`, `userId isoneof
 * [...]`). Both read the context. So an evaluation that carries the user's id
 * ONLY as the entityId cannot match it — for anybody, ever.
 *
 * The stubs below encode that segment's real shape rather than the shape the
 * code happens to send, which is what makes them able to disagree with the code.
 */

// Collapse the sibling-service graph — `resolveTestingAccess` touches nothing but
// Flipt, while importing generation.service pulls in DB / search-index / image
// infra. Mirrors generation.service.generation-disabled-flag.test.ts, MINUS its
// `~/server/redis/client` factory: that module has a canonical mock registered in
// `src/__tests__/setup.ts`, and re-declaring it per-file is what
// `no-direct-shared-module-mock` exists to stop.
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/db/db-lag-helpers', () => ({
  getDbWithoutLag: vi.fn(),
  getDbWithoutLagBatch: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/ecosystems/wan.handler', () => ({
  wanBaseModelGroupIdMap: {},
}));
vi.mock('~/server/search-index', () => ({ modelsSearchIndex: {} }));
vi.mock('~/server/services/common.service', () => ({ hasEntityAccess: vi.fn() }));
vi.mock('~/server/services/model-file.service', () => ({ getFilesForModelVersionCache: vi.fn() }));
vi.mock('~/server/redis/resource-data.redis', () => ({ resourceDataCache: {} }));
vi.mock('~/server/services/model.service', () => ({ getFeaturedModels: vi.fn() }));
vi.mock('~/server/services/model-version.service', () => ({
  getLinkedVaeIds: vi.fn(),
  bustMvCache: vi.fn(),
}));
vi.mock('~/server/services/image.service', () => ({ imagesForModelVersionsCache: {} }));
vi.mock('~/server/services/generation/version-generation-state.service', () => ({
  getVisibleSystemWildcardSetIdsByVersionId: vi.fn(),
}));
vi.mock('~/server/utils/otel-helpers', () => ({
  withSpan: (_name: string, fn: () => unknown) => fn(),
}));

const { mockIsFlipt } = vi.hoisted(() => ({ mockIsFlipt: vi.fn() }));
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return { ...actual, isFlipt: (...args: unknown[]) => mockIsFlipt(...args) };
});

const { resolveTestingAccess } = await import('~/server/services/generation/generation.service');

/**
 * A userId on the live `testers` list, and one that is not.
 *
 * 🔴 Deliberately NOT the ids the flag actually carries. If the fixture used a
 * real entry, a mutant that hardcoded that literal would survive. These two are
 * pairwise distinct from each other and from every constant the code names.
 */
const TESTER_ID = 5150;
const OUTSIDER_ID = 90210;

/**
 * The live `testers` segment, transcribed from flipt-state:
 * ANY_MATCH over `isModerator eq "true"` OR `userId isoneof [...]`, both
 * STRING_COMPARISON_TYPE — i.e. both read the CONTEXT.
 *
 * Note what it does NOT look at: the `entityId` argument. That omission is the
 * whole point, and it is why this stub can fail code that "passes the user id".
 */
const testersSegment = async (_flag: string, _entityId: string, context?: Record<string, string>) =>
  context?.isModerator === 'true' || context?.userId === String(TESTER_ID);

beforeEach(() => {
  vi.clearAllMocks();
  mockIsFlipt.mockImplementation(testersSegment);
});

const evalCalls = () =>
  mockIsFlipt.mock.calls as [string, string, Record<string, string> | undefined][];

describe('resolveTestingAccess evaluates generation-testing against the testers segment', () => {
  it('lets a listed tester through', async () => {
    await expect(resolveTestingAccess({ id: TESTER_ID, isModerator: false })).resolves.toBe(true);
  });

  it('keeps a non-tester out', async () => {
    await expect(resolveTestingAccess({ id: OUTSIDER_ID, isModerator: false })).resolves.toBe(
      false
    );
  });

  it('puts the user id in the CONTEXT, not only in the entityId argument', async () => {
    await resolveTestingAccess({ id: TESTER_ID, isModerator: false });

    expect(evalCalls()).toHaveLength(1);
    const [flag, entityId, context] = evalCalls()[0];
    // The hand-typed contract with flipt-state's features.yaml.
    expect(flag).toBe('generation-testing');
    expect(entityId).toBe(String(TESTER_ID));
    // 🔴 The load-bearing assertion. `entityId` above being right is precisely
    // what made the defect look fine; only the context property is read by a
    // STRING_COMPARISON_TYPE constraint.
    expect(context?.userId).toBe(String(TESTER_ID));
  });

  it('still reports isModerator=false for a non-moderator, so the mods arm is not spoofed', async () => {
    // The function answers `true` for a moderator BEFORE reaching Flipt. If it
    // also claimed `isModerator: 'true'` here, every non-moderator would match
    // the segment's first constraint and the tester list would be moot.
    await resolveTestingAccess({ id: OUTSIDER_ID, isModerator: false });
    expect(evalCalls()[0][2]?.isModerator).toBe('false');
  });

  it('does not fabricate a tier, membership or cohort it was never given', async () => {
    // This caller is handed `{ id, isModerator }`, not a SessionUser. Emitting a
    // defaulted `tier: 'free'` / `isEarlyAdopter: 'false'` would let a rollout
    // scoped to either match on a value nobody here knows.
    await resolveTestingAccess({ id: OUTSIDER_ID, isModerator: false });
    const context = evalCalls()[0][2] ?? {};
    expect(Object.keys(context).sort()).toEqual(['isModerator', 'userId']);
  });

  it('answers true for a moderator without evaluating the flag at all', async () => {
    await expect(resolveTestingAccess({ id: OUTSIDER_ID, isModerator: true })).resolves.toBe(true);
    expect(mockIsFlipt).not.toHaveBeenCalled();
  });

  it('answers false for an anonymous caller without evaluating the flag at all', async () => {
    await expect(resolveTestingAccess({})).resolves.toBe(false);
    expect(mockIsFlipt).not.toHaveBeenCalled();
  });
});

/**
 * NEGATIVE CONTROL for the stub itself.
 *
 * Every assertion above is a claim about what `testersSegment` answers. A stub
 * that answered `true` unconditionally would make "a listed tester gets through"
 * pass while proving nothing, and a stub that answered `false` unconditionally
 * would make "a non-tester is kept out" pass the same way. So drive the stub
 * directly, with the two shapes that matter.
 */
describe('the testers-segment stub reads the context and ignores the entityId', () => {
  it('matches on a context userId', async () => {
    await expect(testersSegment('generation-testing', 'ignored', { userId: '5150' })).resolves.toBe(
      true
    );
  });

  it('does NOT match the same id passed only as the entityId — the defect shape', async () => {
    await expect(
      testersSegment('generation-testing', String(TESTER_ID), { isModerator: 'false' })
    ).resolves.toBe(false);
  });
});
