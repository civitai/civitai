import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MOD_ACTION, abuseReportInput } from '@civitai/moderation';

/**
 * The abuse-detection report surface: the wire contract, the write, and the jsonb hardening.
 *
 * The `getAbuseRuns` / `getAbuseFindings` read chains are deliberately NOT faked. A stand-in good
 * enough to resolve them would answer from a fixture rather than from the recorded query, and so
 * could not tell a correctly-scoped query from one scoped to the wrong rows — the exact weakness the
 * sibling report tests were written to avoid. Their one piece of real decision logic is `asCounters`,
 * which is pure and tested as such below.
 */

type Call = [string, unknown[]];

/** Records every builder call so an assertion can read the query that was actually built. */
function insertChain(calls: Call[], resolveWith: unknown) {
  const builder: Record<string, unknown> = {};
  // `onConflict` takes a callback and must return the builder — the upsert chain runs through it, so
  // omitting it here would make every `recordAbuseRun` test throw rather than assert.
  for (const method of ['values', 'returning', 'onConflict', 'where']) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, args]);
      return builder;
    };
  }
  builder.executeTakeFirstOrThrow = async () => resolveWith;
  builder.execute = async () => [];
  return builder;
}

const { calls, insertInto, transactionExecute } = vi.hoisted(() => {
  const calls: [string, unknown[]][] = [];
  return {
    calls,
    insertInto: vi.fn(),
    transactionExecute: vi.fn(),
  };
});

vi.mock('../abuse-detection-db', () => ({
  getAbuseDetectionDb: () => ({
    transaction: () => ({ execute: transactionExecute }),
  }),
}));

const { recordAbuseRun, asCounters } = await import('../abuse-detection.service');

beforeEach(() => {
  calls.length = 0;
  insertInto.mockReset();
  transactionExecute.mockReset();

  // The trx handed to the callback. `insertInto` records the table so a test can assert BOTH inserts
  // happened (or that the second did not).
  const trx = {
    insertInto: (table: string) => {
      calls.push(['insertInto', [table]]);
      return insertChain(calls, { id: 4242 });
    },
    deleteFrom: (table: string) => {
      calls.push(['deleteFrom', [table]]);
      return insertChain(calls, undefined);
    },
  };
  transactionExecute.mockImplementation(async (cb: (t: unknown) => unknown) => cb(trx));
});

const tables = () => calls.filter(([m]) => m === 'insertInto').map(([, a]) => a[0]);
/**
 * The row handed to `.values()` for a table. The run insert passes ONE object and the findings insert
 * passes an ARRAY, so this normalises to the first row either way — reading `[0]` blindly returns the
 * whole array for the findings insert, and every field assertion then compares against `undefined`.
 */
const valuesFor = (table: string) => {
  const at = calls.findIndex(([m, a]) => m === 'insertInto' && a[0] === table);
  const values = calls.slice(at).find(([m]) => m === 'values');
  const arg = values?.[1][0];
  return Array.isArray(arg) ? arg[0] : arg;
};

const baseRun = {
  detector: 'reaction-abuse',
  startedAt: '2026-08-21T11:00:00.000Z',
  finishedAt: '2026-08-21T11:04:00.000Z',
};

describe('abuseReportInput — the wire contract', () => {
  it('accepts a report with NO acting moderator', () => {
    // The whole reason this action departs from the registry's shape: a scheduled detector has no
    // person behind it, and requiring one would force a caller to invent a user id.
    const parsed = abuseReportInput.safeParse({ ...baseRun, findings: [] });
    expect(parsed.success).toBe(true);
  });

  it('accepts a finding that was NOT acted on, with no action named', () => {
    // The common case, and the one no pre-existing surface can represent.
    const parsed = abuseReportInput.safeParse({
      ...baseRun,
      findings: [
        { userId: 5, confidence: 0.42, reason: 'ring of 3, low concentration', actioned: false },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ['confidence above 1', 1.4],
    ['negative confidence', -0.1],
  ])('rejects %s', (_label, confidence) => {
    const parsed = abuseReportInput.safeParse({
      ...baseRun,
      findings: [{ userId: 5, confidence, reason: 'r', actioned: false }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a run whose timestamps are not ISO-8601', () => {
    // The producer's clock is load-bearing — a run reported late must not read as a late run — so a
    // sloppy timestamp has to fail loudly rather than fall back to receipt time.
    const parsed = abuseReportInput.safeParse({
      ...baseRun,
      startedAt: '21/08/2026 11:00',
      findings: [],
    });
    expect(parsed.success).toBe(false);
  });

  it('is registered under a stable action name', () => {
    expect(MOD_ACTION.abuseReport).toBe('abuse-report');
  });

  // 🔴 The contract must not admit a row the table's CHECK forbids. A CHECK violation aborts the
  // transaction, which loses the ENTIRE run — the exact failure the single transaction was chosen to
  // prevent. Rejecting at the edge is the only place it costs one report instead of all of them.
  it('rejects an actioned finding that names no action', () => {
    const parsed = abuseReportInput.safeParse({
      ...baseRun,
      findings: [{ userId: 5, confidence: 0.9, reason: 'r', actioned: true }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-actioned finding that names an action', () => {
    const parsed = abuseReportInput.safeParse({
      ...baseRun,
      findings: [{ userId: 5, confidence: 0.1, reason: 'r', actioned: false, action: 'exclude' }],
    });
    expect(parsed.success).toBe(false);
  });

  // `user_id` is a Postgres `integer`. An out-of-range value does not miss, it ERRORS the insert —
  // and inside the transaction that loses the run. `$lib/server/query.ts` already bounds ids by
  // MAX_INT4 for exactly this reason.
  it('rejects a userId beyond int4', () => {
    const parsed = abuseReportInput.safeParse({
      ...baseRun,
      findings: [{ userId: 2_147_483_648, confidence: 0.5, reason: 'r', actioned: false }],
    });
    expect(parsed.success).toBe(false);
  });

  // A producer emitting `+00:00` (Python's `datetime.isoformat()`) is ISO-8601 and must not be
  // refused — the comment promises ISO-8601, and a 400 here loses the whole run.
  it.each([
    ['Z', '2026-08-21T11:00:00.000Z'],
    ['+00:00 offset', '2026-08-21T11:00:00+00:00'],
    ['+02:00 offset', '2026-08-21T13:00:00+02:00'],
  ])('accepts an ISO-8601 timestamp with %s', (_label, startedAt) => {
    const parsed = abuseReportInput.safeParse({
      ...baseRun,
      startedAt,
      finishedAt: '2026-08-21T23:00:00Z',
      findings: [],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a run that finished before it started', () => {
    // Otherwise a transposed pair renders as a negative duration on a board whose whole claim is
    // "when did this happen".
    const parsed = abuseReportInput.safeParse({
      startedAt: '2026-08-21T11:04:00.000Z',
      finishedAt: '2026-08-21T11:00:00.000Z',
      detector: 'reaction-abuse',
      findings: [],
    });
    expect(parsed.success).toBe(false);
  });

  // Most JSON serialisers emit `null` for an empty map / absent string. Refusing the run over it
  // would lose a report for a formatting choice.
  it.each([
    ['counters', { counters: null }],
    ['summary', { summary: null }],
  ])('treats a null %s as absent rather than refusing the run', (_label, extra) => {
    const parsed = abuseReportInput.safeParse({ ...baseRun, ...extra, findings: [] });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ['reason', { userId: 5, confidence: 0.5, reason: '', actioned: false }],
    ['action', { userId: 5, confidence: 0.5, reason: 'r', actioned: true, action: '' }],
  ])('rejects an empty %s', (_label, finding) => {
    // An empty action renders as a blank "Acted" cell — the "reads as missing data" failure the
    // detail page is written to avoid.
    const parsed = abuseReportInput.safeParse({ ...baseRun, findings: [finding] });
    expect(parsed.success).toBe(false);
  });
});

describe('recordAbuseRun', () => {
  it('writes the run and its findings in ONE transaction', async () => {
    await recordAbuseRun({
      ...baseRun,
      summary: 'daily',
      counters: { candidates: 9 },
      findings: [
        { userId: 7, confidence: 0.95, reason: 'ring', actioned: true, action: 'exclude' },
      ],
    });

    // A run header whose findings failed to land renders as "0 findings", which is indistinguishable
    // from a genuinely clean run.
    expect(transactionExecute).toHaveBeenCalledTimes(1);
    expect(tables()).toEqual(['abuse_detection_run', 'abuse_detection_finding']);
  });

  it('passes the PRODUCER timestamps through, not receipt time', async () => {
    await recordAbuseRun({ ...baseRun, findings: [] });

    const values = valuesFor('abuse_detection_run') as { started_at: Date; finished_at: Date };
    expect(values.started_at.toISOString()).toBe('2026-08-21T11:00:00.000Z');
    expect(values.finished_at.toISOString()).toBe('2026-08-21T11:04:00.000Z');
  });

  // Found by a negative control that was SUPPOSED to be caught and wasn't: hardcoding `detector` in
  // the insert left the whole suite green. A wrong detector files every run under another producer,
  // where the board groups by exactly that column.
  it('writes the reported detector and summary, not a substitute', async () => {
    await recordAbuseRun({ ...baseRun, summary: 'daily digest line', findings: [] });

    const values = valuesFor('abuse_detection_run') as { detector: string; summary: string | null };
    expect(values.detector).toBe('reaction-abuse');
    expect(values.summary).toBe('daily digest line');
  });

  it('stores an absent summary as NULL rather than the string "undefined"', async () => {
    await recordAbuseRun({ ...baseRun, findings: [] });
    const values = valuesFor('abuse_detection_run') as { summary: string | null };
    expect(values.summary).toBeNull();
  });

  it('drops an action name on a finding that was NOT actioned', async () => {
    // The table CHECK forbids the pair, and a CHECK violation aborts the transaction and loses the
    // whole run — so this is normalised rather than trusted.
    await recordAbuseRun({
      ...baseRun,
      findings: [
        {
          userId: 7,
          confidence: 0.5,
          reason: 'r',
          actioned: false,
          action: 'exclude' as unknown as string,
        },
      ],
    });

    const values = valuesFor('abuse_detection_finding') as { action: string | null };
    expect(values.action).toBeNull();
  });

  it('keeps the action name when the finding WAS actioned', async () => {
    await recordAbuseRun({
      ...baseRun,
      findings: [{ userId: 7, confidence: 0.9, reason: 'r', actioned: true, action: 'exclude' }],
    });

    const values = valuesFor('abuse_detection_finding') as { action: string | null };
    expect(values.action).toBe('exclude');
  });

  it('skips the findings insert entirely when there are none', async () => {
    await recordAbuseRun({ ...baseRun, findings: [] });
    // The delete still runs: a replay that legitimately reports zero findings must CLEAR the
    // previous attempt's rows, not leave them attached to a run that no longer claims them.
    expect(tables()).toEqual(['abuse_detection_run']);
    expect(calls.some(([m, a]) => m === 'deleteFrom' && a[0] === 'abuse_detection_finding')).toBe(
      true
    );
  });

  // The producers retry. A POST that commits but whose response is lost is sent again, so the write
  // has to be replayable without duplicating either the run or its findings.
  it('clears prior findings BEFORE re-inserting, so a replay does not double them', async () => {
    await recordAbuseRun({
      ...baseRun,
      findings: [{ userId: 7, confidence: 0.9, reason: 'r', actioned: true, action: 'exclude' }],
    });

    const order = calls
      .filter(([m]) => m === 'deleteFrom' || m === 'insertInto')
      .map(([m, a]) => `${m}:${a[0]}`);
    expect(order).toEqual([
      'insertInto:abuse_detection_run',
      'deleteFrom:abuse_detection_finding',
      'insertInto:abuse_detection_finding',
    ]);
  });

  it('upserts the run rather than inserting a second copy', async () => {
    await recordAbuseRun({ ...baseRun, findings: [] });
    expect(calls.some(([m]) => m === 'onConflict')).toBe(true);
  });

  it('defaults absent counters to an empty object rather than null', async () => {
    // The column is NOT NULL; a null here would abort the run.
    await recordAbuseRun({ ...baseRun, findings: [] });
    const values = valuesFor('abuse_detection_run') as { counters: string };
    expect(values.counters).toBe('{}');
  });
});

describe('asCounters — jsonb comes back as whatever was stored', () => {
  it('keeps finite numbers', () => {
    expect(asCounters({ candidates: 9, excluded: 0 })).toEqual({ candidates: 9, excluded: 0 });
  });

  it.each([
    ['an array', [1, 2]],
    ['a scalar', 7],
    ['a string', 'nine'],
    ['null', null],
  ])('renders nothing for %s', (_label, raw) => {
    expect(asCounters(raw)).toEqual({});
  });

  it('drops non-numeric and non-finite values instead of rendering them', () => {
    // A counter panel showing `[object Object]` or `NaN` is worse than an absent one — it reads as a
    // measurement that was taken.
    expect(
      asCounters({ good: 3, nested: { a: 1 }, notANumber: NaN, infinite: Infinity, text: '5' })
    ).toEqual({ good: 3 });
  });
});
