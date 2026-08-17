import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as UserService from '~/server/services/user.service';

// ---------------------------------------------------------------------------
// WHY THIS SUITE EXISTS
//
// `firstDailyFollow` and `generation-feedback` are deprecated by a `rewards:config`
// row rather than by deleting them, so the only thing standing between a follow (or
// a generator feedback click) and a Blue Buzz grant is the gate inside `apply`.
// base.reward.config.test.ts proves the gate works on a locally-built reward. This
// suite proves it works FROM THE TWO CALL SITES THAT ACTUALLY PAY, using the real
// exported reward objects rather than a fixture.
//
// The distinction is not academic. The earlier deletion-shaped version of this work
// found that `user.controller` imports `firstDailyFollowReward` direct-from-file
// while `orchestrator.router` imports from the barrel, so "the mechanism works" and
// "this call site is covered" were separate questions once before.
//
// Every disabled-case assertion below is paired with an enabled control that
// observes a real payment through the same seam. Without the control, a suite that
// stopped reaching `sendAward` for any unrelated reason — a changed mock, a moved
// import — would keep passing while proving nothing.
//
// 🔴 Do NOT mock `~/env/server` here, in any spelling. Importing `orchestrator.router`
// below constructs an OrchestratorCaller at MODULE scope, whose two env vars are
// worker-level defaults in the canonical `~/__tests__/mocks/env.mock`. An
// `importOriginal` spread loads the REAL env and validates it: green locally, and
// `Invalid environment variables` at COLLECTION wherever a `.env` is absent — surfaced
// as an unrelated `vi.mock` hoisting error two frames out. Nothing catches it locally;
// `~/env/server` is PENDING in `guarded-specifiers.ts`, counted rather than enforced.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  insert: vi.fn(async () => undefined),
  query: vi.fn(async () => [] as unknown[]),
  createBuzzTransactionMany: vi.fn(async () => ({ transactions: [] })),
  getMultipliersForUser: vi.fn(async () => ({ rewardsMultiplier: 1 })),
  toggleFollowUser: vi.fn(async () => true),
  patchWorkflowSteps: vi.fn(async () => undefined),
  getOrchestratorToken: vi.fn(async () => 'token'),
}));

vi.mock('~/server/clickhouse/client', () => ({
  clickhouse: {
    insert: (...args: any[]) => h.insert(...args),
    $query: (...args: any[]) => h.query(...args),
    query: vi.fn(async () => ({ json: async () => [] })),
  },
}));

vi.mock('~/server/services/buzz.service', () => ({
  createBuzzTransactionMany: (...args: any[]) => h.createBuzzTransactionMany(...args),
  getMultipliersForUser: (...args: any[]) => h.getMultipliersForUser(...args),
  createBuzzTransaction: vi.fn(),
}));

vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  toggleFollowUser: (...args: any[]) => h.toggleFollowUser(...args),
}));

vi.mock('~/server/services/orchestrator/workflowSteps', () => ({
  patchWorkflowSteps: (...args: any[]) => h.patchWorkflowSteps(...args),
}));

vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: (...args: any[]) => h.getOrchestratorToken(...args),
}));

vi.mock('~/server/search-index', () => ({ usersSearchIndex: { queueUpdate: vi.fn() } }));
vi.mock('~/server/cloudflare/client', () => ({ purgeCache: vi.fn(async () => undefined) }));

import { readFileSync } from 'node:fs';
import { firstDailyFollowReward } from '~/server/rewards/active/firstDailyFollow.reward';
import { generatorFeedbackReward } from '~/server/rewards';
import * as rewardImports from '~/server/rewards';
import { invalidateRewardConfigCache } from '~/server/rewards/reward-config';
import {
  toggleFollowUserHandler,
  userRewardDetailsHandler,
} from '~/server/controllers/user.controller';
import { orchestratorRouter } from '~/server/routers/orchestrator.router';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const AWARD = 10;

const configRow = dbMock.dbRead.keyValue.findUnique;
const disable = (...types: string[]) =>
  configRow.mockResolvedValue({
    value: { rewards: Object.fromEntries(types.map((type) => [type, { enabled: false }])) },
  });

beforeEach(() => {
  vi.clearAllMocks();
  invalidateRewardConfigCache();
  // No row at all: every reward runs on its compiled defaults, i.e. enabled. This
  // is the control state, and it has to actually pay for the tests to mean anything.
  configRow.mockResolvedValue(null);
  h.getMultipliersForUser.mockResolvedValue({ rewardsMultiplier: 1 });
  h.toggleFollowUser.mockResolvedValue(true);
  redisMock.redis.eval.mockResolvedValue(AWARD as never);
  redisMock.redis.hGet.mockResolvedValue('{}' as never);
});

const paidTypes = () =>
  h.createBuzzTransactionMany.mock.calls.flatMap(([transactions]: any) =>
    (transactions as any[]).map((t) => t.details?.type)
  );

// ---------------------------------------------------------------------------
// Call site 1 — firstDailyFollow, from user.controller's toggleFollowUserHandler.
//
// This is the call site that the deletion-shaped version of this work would have
// silently left paying, because the reward is imported direct-from-file rather than
// through `~/server/rewards`. `apply` is awaited here, so these assertions are
// deterministic.
// ---------------------------------------------------------------------------
describe('firstDailyFollow — from toggleFollowUserHandler', () => {
  const follow = () =>
    toggleFollowUserHandler({
      input: { targetUserId: 99 },
      ctx: {
        user: { id: 7 },
        ip: '1.2.3.4',
        track: { userEngagement: vi.fn(async () => undefined) },
      },
    } as never);

  it('pays on a follow while the reward is enabled', async () => {
    await follow();
    expect(paidTypes()).toContain('firstDailyFollow');
  });

  it('pays nothing on a follow once the reward is disabled', async () => {
    disable('firstDailyFollow');
    await follow();
    expect(h.createBuzzTransactionMany).not.toHaveBeenCalled();
  });

  it('does no work at all for the disabled reward — no dedup entry, no audit row', async () => {
    disable('firstDailyFollow');
    await follow();
    // The gate is the first statement of `apply`, so nothing downstream of it runs.
    // Asserting this rather than only the payment is what distinguishes "gated" from
    // "granted zero", which would still burn the day's dedup entry.
    expect(redisMock.redis.eval).not.toHaveBeenCalled();
    expect(h.insert).not.toHaveBeenCalled();
  });

  it('still follows the user when the reward is disabled', async () => {
    disable('firstDailyFollow');
    const result = await follow();
    // Deprecating a reward must not break the action that used to earn it.
    expect(h.toggleFollowUser).toHaveBeenCalled();
    expect(result).toEqual({ following: true });
  });
});

// ---------------------------------------------------------------------------
// Call site 2 — generation-feedback, from orchestrator.router's `patch`.
//
// ⚠️ This call site is FIRE-AND-FORGET, and that shapes the test. `patch` builds
// `Promise.all(steps.map(step => step.patches.filter(...).map(async ...)))`, which
// hands `Promise.all` an array of ARRAYS. Arrays are not thenables, so they resolve
// to themselves immediately and the inner promises are awaited by nothing.
//
// So a bare `expect(...).not.toHaveBeenCalled()` after `await caller.patch(...)`
// would pass whether the gate works or not — it runs before the grant would have
// happened either way.
//
// The fix is `flushMicrotasks` plus a control that uses the SAME flush. Every
// dependency on the grant path is mocked async, so the floating work is a pure
// microtask chain with no timers in it: draining microtasks is exhaustive, where a
// `setTimeout` or a `vi.waitFor` timeout would give the two cases windows of
// different lengths and make the disabled assertion a race. The enabled control
// observing a payment through the same flush is what proves the window is long
// enough for the disabled case's silence to be evidence.
// ---------------------------------------------------------------------------

// Deep enough for the chain above (getKey → multipliers → Lua → CH insert →
// sendAward), with room to spare; short enough that a genuine hang still fails fast.
const flushMicrotasks = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
describe('generation-feedback — from the orchestrator patch mutation', () => {
  const patch = () =>
    orchestratorRouter
      .createCaller({
        user: { id: 7 },
        ip: '1.2.3.4',
        features: {},
        acceptableOrigin: true,
        // Session auth, i.e. the browser path this mutation is actually called from.
        tokenScope: TokenScope.Full,
        apiKeyId: null,
      } as never)
      .patch({
        steps: [
          {
            workflowId: 'wf_1',
            stepName: 'step_1',
            patches: [{ op: 'add', path: '/images/job_abc/feedback' }],
          },
        ],
      });

  // The control for the test below. If this ever stops observing a payment, the
  // disabled case proves nothing and this failure is the warning.
  it('pays for feedback while the reward is enabled', async () => {
    await patch();
    await flushMicrotasks();
    expect(paidTypes()).toContain('generation-feedback');
  });

  it('pays nothing for feedback once the reward is disabled', async () => {
    disable('generation-feedback');
    await patch();
    await flushMicrotasks();
    expect(h.createBuzzTransactionMany).not.toHaveBeenCalled();
  });

  it('still applies the step patches when the reward is disabled', async () => {
    disable('generation-feedback');
    await patch();
    // The feedback itself is persisted by `patchWorkflowSteps`, not by the reward.
    expect(h.patchWorkflowSteps).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The advertising door. A reward that quietly stops paying is a support ticket; a
// reward still listed at an amount it will never pay is a broken promise on a page.
// ---------------------------------------------------------------------------
describe('the rewards list stops advertising both', () => {
  const listed = async () => {
    const rewards = await userRewardDetailsHandler({ ctx: { user: { id: 7 } } } as never);
    return rewards.map((r: { type: string }) => r.type);
  };

  it('lists both while they are enabled', async () => {
    const types = await listed();
    expect(types).toContain('firstDailyFollow');
    expect(types).toContain('generation-feedback');
  });

  it('drops both once they are disabled', async () => {
    disable('firstDailyFollow', 'generation-feedback');
    const types = await listed();
    expect(types).not.toContain('firstDailyFollow');
    expect(types).not.toContain('generation-feedback');
  });

  it('leaves the other rewards listed', async () => {
    disable('firstDailyFollow', 'generation-feedback');
    const types = await listed();
    // Scoping matters: the row is shared, and a gate keyed on the wrong thing would
    // take the whole list down rather than two entries.
    expect(types).toContain('dailyBoost');
    expect(types.length).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Neither reward can exercise `process`. Both are `onDemand`, so `apply` writes
// `awarded` or `capped` inline and never the `pending` row that `process` pays.
// Recorded as an assertion rather than a comment so that making one of them
// processable — which would put it back in the sweep's path — fails here.
// ---------------------------------------------------------------------------
describe('both are on-demand, so the process sweep does not apply to them', () => {
  it.each([
    ['firstDailyFollow', firstDailyFollowReward],
    ['generation-feedback', generatorFeedbackReward],
  ])('%s writes no pending row', async (_type, reward) => {
    await reward.process({ toProcess: [], lastUpdate: new Date(0), ch: {}, db: {} } as never);
    expect(h.query).not.toHaveBeenCalled();
    expect(h.createBuzzTransactionMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The migration is the deprecation, and it addresses rewards by their `type`
// STRING. A typo there is the quietest possible failure: the row writes, the SQL
// reports success, and the reward keeps paying under a key nothing reads. Nothing
// else in the codebase connects that file to these identifiers, so this is the only
// place the two can be held together.
// ---------------------------------------------------------------------------
describe('the migration disables reward types that exist', () => {
  const sql = readFileSync(
    new URL(
      '../../../../packages/civitai-db-schema/prisma/migrations/20260817120000_disable_follow_and_feedback_rewards/migration.sql',
      import.meta.url
    ),
    'utf8'
  );

  const configured = JSON.parse(/VALUES \(\s*'rewards:config',\s*'([^']+)'/.exec(sql)?.[1] ?? '{}')
    .rewards as Record<string, { enabled?: boolean }>;

  const knownTypes = Object.values(rewardImports).flatMap((reward) => reward.types);

  it('names exactly the two rewards this PR deprecates', () => {
    expect(Object.keys(configured).sort()).toEqual(['firstDailyFollow', 'generation-feedback']);
  });

  it.each(['firstDailyFollow', 'generation-feedback'])('%s is a real reward type', (type) => {
    expect(knownTypes).toContain(type);
  });

  it.each(['firstDailyFollow', 'generation-feedback'])('%s is turned off, not on', (type) => {
    expect(configured[type]).toEqual({ enabled: false });
  });

  it('sets the same two keys in the ON CONFLICT branch as in the insert', () => {
    // The insert and the merge branch name the rewards separately, so they can drift.
    // A reward disabled on a fresh row but not on an existing one is the worst case:
    // it works in preview, where the row is absent, and not in production.
    for (const type of Object.keys(configured)) {
      expect(sql).toContain(`'{rewards,${type}}'`);
    }
  });
});
