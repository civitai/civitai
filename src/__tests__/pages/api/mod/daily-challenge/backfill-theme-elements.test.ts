import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

// Regression guard for the "backfill wedges a challenge forever" defect.
//
// The handler SELECTs Active/Scheduled challenges from the READ REPLICA, spends multiple seconds
// in an LLM call (generateThemeElements), then writes metadata back. The original write was keyed
// on `id` alone and replaced the whole column from the pre-LLM snapshot. If
// `claimChallengeForCompletion` flipped the challenge to Completing inside that window — stamping
// metadata.completingClaimedAt as it went — the write restored the pre-claim snapshot on top of
// the fresh stamp, leaving status=Completing with NO completingClaimedAt. The stuck-challenge
// reset propagates NULL and so never selects such a row: the challenge wedges permanently.
// `?force=true` widens the exposure to every themed Active/Scheduled challenge at once.

const { mockQueryRaw, mockExecuteRaw, mockGenerateThemeElements, mockLogToAxiom } = vi.hoisted(
  () => ({
    mockQueryRaw: vi.fn(),
    mockExecuteRaw: vi.fn(),
    mockGenerateThemeElements: vi.fn(),
    mockLogToAxiom: vi.fn(),
  })
);

vi.mock('~/server/db/client', () => ({
  dbRead: { $queryRaw: mockQueryRaw },
  dbWrite: { $executeRaw: mockExecuteRaw },
}));

vi.mock('~/server/games/daily-challenge/daily-challenge.utils', () => ({
  getChallengeConfig: vi.fn().mockResolvedValue({ defaultJudgeId: 1 }),
  getJudgingConfig: vi.fn().mockResolvedValue({ userId: 1 }),
}));

vi.mock('~/server/games/daily-challenge/generative-content', () => ({
  generateThemeElements: mockGenerateThemeElements,
}));

vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));

vi.mock('~/server/schema/challenge.schema', () => ({
  parseChallengeMetadata: (m: unknown) => (m ?? {}) as Record<string, unknown>,
}));

// Run the generated tasks sequentially so assertions are deterministic.
vi.mock('~/server/utils/concurrency-helpers', () => ({
  limitConcurrency: async (tasks: Array<() => Promise<void>>) => {
    for (const t of tasks) await t();
  },
}));

type ApiHandler = (req: NextApiRequest, res: NextApiResponse) => unknown;

vi.mock('~/server/utils/endpoint-helpers', () => ({
  WebhookEndpoint: (handler: ApiHandler) => handler,
}));

vi.mock('~/utils/logging', () => ({ createLogger: vi.fn(() => vi.fn()) }));

vi.mock('~/env/server', () => ({
  env: new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'WEBHOOK_TOKEN') return 'mock-webhook-token';
        if (prop === 'IS_BUILD') return false;
        if (prop === 'LOGGING') return [];
        return 'mock-value';
      },
    }
  ),
}));

const handler = (await import('~/pages/api/mod/daily-challenge/backfill-theme-elements')).default;

/** Reassemble the SQL text from the tagged-template call `$executeRaw` received. */
const sqlOf = (call: unknown[]) => (call[0] as string[]).join('?').replace(/\s+/g, ' ').trim();

// The statement is pinned WHOLE rather than by feature-regexes. These assertions can only ever
// check TEXT — there is no Postgres in a unit test to give them semantics — and partial regexes
// proved far weaker than they looked: an earlier version pinned the presence of `||` and
// `jsonb_typeof`, and three semantically-broken statements still passed. All three are text-level
// edits that a whole-statement match rejects outright:
//   - swapping the `||` operands (stored value wins; ?force=true becomes a silent no-op)
//   - inverting the CASE branches (unconditionally WIPES existing metadata — worse than the bug)
//   - commenting out the status predicate (disables this PR's primary guard, yet the text remains
//     present for any regex looking for it)
// Cost of pinning it whole: a cosmetic reformat of the SQL fails this test and must be mirrored
// here. That is the intended trade for a statement whose exact shape is the fix.
const EXPECTED_SQL =
  `UPDATE "Challenge" ` +
  `SET metadata = ` +
  `CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END ` +
  `|| ?::jsonb ` +
  `WHERE id = ? ` +
  `AND status IN ('Active', 'Scheduled')`;

const runRequest = (query: Record<string, string> = {}) => {
  const req = {
    method: 'POST',
    query: { token: 'mock-webhook-token', ...query },
    headers: { host: 'localhost:3000' },
    body: {},
  } as unknown as NextApiRequest;

  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  } as unknown as NextApiResponse;

  return { promise: handler(req, res), res };
};

// Metadata must be NON-EMPTY and carry sibling keys. With `metadata: {}` a bound patch and a
// rebuilt whole-snapshot payload are byte-identical, so the "only the patch is bound" assertion
// below could not tell the fix from the defect it replaced.
const CHALLENGE = {
  id: 42,
  theme: 'Neon',
  judgeId: 1,
  metadata: { completingClaimedAt: '2026-01-01T00:00:00.000Z', reviewedAt: 17 },
};

describe('backfill-theme-elements — must not clobber a challenge claimed for completion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueryRaw.mockResolvedValue([CHALLENGE]);
    mockGenerateThemeElements.mockResolvedValue(['neon', 'glow']);
    mockExecuteRaw.mockResolvedValue(1);
  });

  it('predicates the metadata write on the challenge still being Active/Scheduled', async () => {
    const { promise } = runRequest();
    await promise;

    expect(mockExecuteRaw).toHaveBeenCalledTimes(1);
    // Without the status predicate the write lands on a Completing challenge and wedges it.
    expect(sqlOf(mockExecuteRaw.mock.calls[0])).toBe(EXPECTED_SQL);
  });

  it('merges onto the stored metadata instead of replacing the whole column', async () => {
    const { promise } = runRequest();
    await promise;

    // `stored || patch` touches only themeElements, so a field written during the LLM window
    // (e.g. completingClaimedAt) survives even inside Active/Scheduled.
    expect(sqlOf(mockExecuteRaw.mock.calls[0])).toBe(EXPECTED_SQL);
    // Only the themeElements patch is bound — NOT a rebuilt copy of the whole snapshot. The
    // fixture's sibling keys must be absent here: rebinding them is the original defect, and the
    // database (not this process) is what supplies them via the `||` above.
    expect(JSON.parse(mockExecuteRaw.mock.calls[0][1] as string)).toEqual({
      themeElements: ['neon', 'glow'],
    });
  });

  it('reports a challenge that left Active/Scheduled as skipped, not backfilled', async () => {
    mockExecuteRaw.mockResolvedValue(0); // predicate matched nothing — it was claimed mid-flight

    const { promise, res } = runRequest();
    await promise;

    const payload = (res.json as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.backfilled).toBe(0);
    expect(payload.failures).toBe(0);
    // Counted, so `attempted === backfilled + failures + skipped` closes.
    expect(payload.skipped).toBe(1);
    expect(payload.results).toEqual([
      { id: 42, theme: 'Neon', status: 'skipped: no longer Active/Scheduled' },
    ]);
    // The race is otherwise invisible: `skipped:` in the response covers three different reasons,
    // so the log is the only thing that identifies THIS one. Assert it fires.
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'backfill-theme-elements-skipped', challengeId: 42 })
    );
  });

  it('still counts a genuine write as backfilled', async () => {
    const { promise, res } = runRequest();
    await promise;

    const payload = (res.json as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(payload.backfilled).toBe(1);
    expect(payload.skipped).toBe(0);
    expect(payload.attempted).toBe(1);
    expect(payload.results[0].status).toBe('ok');
    // No skip, so nothing to report.
    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });

  it('force=true does not bypass the status predicate', async () => {
    const { promise } = runRequest({ force: 'true' });
    await promise;

    expect(sqlOf(mockExecuteRaw.mock.calls[0])).toBe(EXPECTED_SQL);
  });
});
