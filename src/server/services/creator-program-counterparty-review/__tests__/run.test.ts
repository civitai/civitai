import { describe, expect, it, vi } from 'vitest';
import { abuseReportInput, type AbuseReportInput } from '@civitai/moderation';
import { BANKABLE_CUTOVER } from '~/shared/constants/creator-program.constants';
import {
  platformPaidFromUsersSql,
  receivedFromUsersSql,
  SENT_TO_USER_SQL,
} from '~/server/services/creator-program-bankable';
import { buzzBankTypesSql } from '~/shared/constants/buzz.constants';
import {
  COUNTERPARTY_REVIEW_DETECTOR,
  counterpartyPairsSql,
  indirectTransfersSql,
  PAIR_CEILING,
  type Member,
} from '~/server/services/creator-program-counterparty-review/detect';
import {
  renderWarningMessage,
  WARNED_ACTION,
} from '~/server/services/creator-program-counterparty-review/report';
import {
  runCounterpartyReview,
  type IndirectRecord,
  type ReviewDeps,
  type WarningRecord,
} from '~/server/services/creator-program-counterparty-review/run';

const MIN = 1_000;
const afterCutover = new Date('2026-12-01T10:00:00Z');
const creator: Member = { id: 11, username: 'creator_one' };

type Row = { userId: number; counterpartyId: number; received: number; sent: number };
type IndirectRow = { userId: number; path: number[]; amount: number };

/** One review world: a ClickHouse that returns `rows`, a members table, and a warnings store. */
function world({
  rows = [] as Row[],
  indirectRows = [] as IndirectRow[],
  members = [creator],
  minimum = MIN as number | null,
  maxIntermediaries = 2,
  now = afterCutover,
  sendWarning = vi.fn(async () => ({ chatId: 500 })),
  reportFails = () => false,
} = {}) {
  const store = new Map<number, WarningRecord>();
  const indirectStore = new Map<number, IndirectRecord>();
  const reports: AbuseReportInput[] = [];
  const logs: { name: string; data: Record<string, unknown> }[] = [];
  const ch = {
    $query: vi.fn(
      async (sql: string) =>
        (sql.includes('AS path')
          ? indirectRows.filter((r) => r.path.length <= maxIntermediaries)
          : rows) as never[]
    ),
  };
  const deps: ReviewDeps = {
    ch,
    readMinimum: async () => minimum,
    readMaxIntermediaries: async () => maxIntermediaries,
    findMembers: async (ids) => members.filter((m) => ids.includes(m.id)),
    warnings: {
      get: async (id) => store.get(id) ?? null,
      set: async (id, record) => void store.set(id, record),
    },
    indirect: {
      get: async (id) => indirectStore.get(id) ?? null,
      set: async (id, record) => void indirectStore.set(id, record),
    },
    sendWarning,
    sendReport: async (report) => {
      if (reportFails()) throw new Error('board unavailable');
      reports.push(report);
    },
    now: () => now,
    log: (name, data) => void logs.push({ name, data }),
  };
  return {
    deps,
    ch,
    store,
    indirectStore,
    reports,
    logs,
    sendWarning,
    setRows: (r: Row[]) => (rows = r),
    setIndirectRows: (r: IndirectRow[]) => (indirectRows = r),
  };
}

const pair = (counterpartyId: number, received: number, sent: number): Row => ({
  userId: creator.id,
  counterpartyId,
  received,
  sent,
});

describe('runCounterpartyReview', () => {
  it('does nothing before the bankable cutover', async () => {
    const w = world({
      rows: [pair(22, 5_000, 5_000)],
      now: new Date(BANKABLE_CUTOVER.getTime() - 1),
    });

    expect(await runCounterpartyReview(w.deps)).toMatchObject({ skipped: 'before-cutover' });
    expect(w.ch.$query).not.toHaveBeenCalled();
    expect(w.sendWarning).not.toHaveBeenCalled();
  });

  // Both arms: unset skips loudly and reads nothing; set, the same world files.
  it('skips and says so every run while the minimum is not set', async () => {
    const unset = world({ rows: [pair(22, 5_000, 5_000)], minimum: null });
    expect(await runCounterpartyReview(unset.deps)).toMatchObject({ skipped: 'minimum-not-set' });
    expect(unset.logs).toEqual([
      {
        name: 'creator-program-counterparty-review-skipped',
        data: { reason: 'minimum not set, skipping' },
      },
    ]);
    expect(unset.ch.$query).not.toHaveBeenCalled();
    expect(unset.reports).toHaveLength(0);

    const set = world({ rows: [pair(22, 5_000, 5_000)] });
    expect(await runCounterpartyReview(set.deps)).toMatchObject({ warned: 1 });
    expect(set.reports).toHaveLength(1);
  });

  it('warns a member once, records it, and files a finding that says so', async () => {
    const w = world({ rows: [pair(22, 5_000, 4_000)] });

    expect(await runCounterpartyReview(w.deps)).toEqual({
      pairs: 1,
      warned: 1,
      repeats: 0,
      failed: 0,
      indirect: 0,
    });

    expect(w.sendWarning).toHaveBeenCalledTimes(1);
    expect(w.sendWarning).toHaveBeenCalledWith(creator);
    expect(w.store.get(creator.id)).toEqual({
      warnedAt: afterCutover.toISOString(),
      chatId: 500,
      counterparties: { '22': 4_000 },
    });
    const [report] = w.reports;
    expect(() => abuseReportInput.parse(report)).not.toThrow();
    expect(report.detector).toBe(COUNTERPARTY_REVIEW_DETECTOR);
    expect(report.findings).toEqual([
      expect.objectContaining({ userId: creator.id, actioned: true, action: WARNED_ACTION }),
    ]);
    expect(report.findings[0].reason).toContain(
      'with account 22: received 5,000 Buzz, sent back 4,000'
    );
  });

  it('does not warn again, or file again, when nothing new happened', async () => {
    const w = world({ rows: [pair(22, 5_000, 4_000)] });
    await runCounterpartyReview(w.deps);

    expect(await runCounterpartyReview(w.deps)).toEqual({
      pairs: 1,
      warned: 0,
      repeats: 0,
      failed: 0,
      indirect: 0,
    });
    expect(w.sendWarning).toHaveBeenCalledTimes(1);
    expect(w.reports[1].findings).toEqual([]);
  });

  it('files a warned member again for new volume of at least the minimum, without a second message', async () => {
    const w = world({ rows: [pair(22, 5_000, 4_000)] });
    await runCounterpartyReview(w.deps);

    // Below the minimum of new volume since the warning: not filed.
    w.setRows([pair(22, 6_000, 4_999)]);
    expect(await runCounterpartyReview(w.deps)).toMatchObject({ repeats: 0 });

    w.setRows([pair(22, 6_000, 5_000)]);
    expect(await runCounterpartyReview(w.deps)).toMatchObject({ warned: 0, repeats: 1 });
    expect(w.sendWarning).toHaveBeenCalledTimes(1);
    const repeat = w.reports.at(-1)!;
    expect(() => abuseReportInput.parse(repeat)).not.toThrow();
    expect(repeat.findings).toEqual([
      expect.objectContaining({ userId: creator.id, actioned: false, confidence: 0.95 }),
    ]);
    expect(repeat.findings[0]).not.toHaveProperty('action');
    expect(repeat.findings[0].reason).toContain(`Already warned on 2026-12-01`);
    expect(w.store.get(creator.id)?.counterparties).toEqual({ '22': 5_000 });

    // Filed once for that growth, not every day after it.
    expect(await runCounterpartyReview(w.deps)).toMatchObject({ repeats: 0 });
  });

  it('keeps a repeat for the next run when the report carrying it fails', async () => {
    let failing = false;
    const w = world({ rows: [pair(22, 5_000, 4_000)], reportFails: () => failing });
    await runCounterpartyReview(w.deps);

    w.setRows([pair(22, 6_000, 5_000)]);
    failing = true;
    await expect(runCounterpartyReview(w.deps)).rejects.toThrow('board unavailable');
    expect(w.store.get(creator.id)?.counterparties).toEqual({ '22': 4_000 });

    failing = false;
    expect(await runCounterpartyReview(w.deps)).toMatchObject({ repeats: 1 });
    expect(w.reports.at(-1)!.findings).toEqual([
      expect.objectContaining({ userId: creator.id, actioned: false }),
    ]);
  });

  it('logs when the pair query reaches its ceiling', async () => {
    const rows = Array.from({ length: PAIR_CEILING }, (_, i) => pair(1_000 + i, 5_000, 5_000));
    const w = world({ rows, members: [] });

    await runCounterpartyReview(w.deps);

    expect(w.logs).toContainEqual({
      name: 'creator-program-counterparty-review-ceiling',
      data: { pairs: PAIR_CEILING },
    });
  });

  it('files a new counterparty after a warning as a repeat', async () => {
    const w = world({ rows: [pair(22, 5_000, 4_000)] });
    await runCounterpartyReview(w.deps);

    w.setRows([pair(22, 5_000, 4_000), pair(33, 2_000, 2_000)]);
    expect(await runCounterpartyReview(w.deps)).toMatchObject({ repeats: 1 });
    expect(w.store.get(creator.id)?.counterparties).toEqual({ '22': 4_000, '33': 2_000 });
  });

  it('only messages current Creator Program members', async () => {
    const w = world({
      rows: [
        pair(22, 5_000, 5_000),
        { userId: 99, counterpartyId: 22, received: 5_000, sent: 5_000 },
      ],
    });

    await runCounterpartyReview(w.deps);

    expect(w.sendWarning).toHaveBeenCalledTimes(1);
    expect(w.reports[0].findings.map((f) => f.userId)).toEqual([creator.id]);
  });

  it('retries a warning that could not be sent, and does not record it as sent', async () => {
    const sendWarning = vi
      .fn<ReviewDeps['sendWarning']>()
      .mockRejectedValueOnce(new Error('chat unavailable'))
      .mockResolvedValue({ chatId: 501 });
    const w = world({ rows: [pair(22, 5_000, 5_000)], sendWarning });

    expect(await runCounterpartyReview(w.deps)).toMatchObject({ warned: 0, failed: 1 });
    expect(w.store.has(creator.id)).toBe(false);
    expect(w.reports[0].findings[0]).toMatchObject({ actioned: false });
    expect(w.reports[0].findings[0].reason).toContain('could not be sent (chat unavailable)');

    expect(await runCounterpartyReview(w.deps)).toMatchObject({ warned: 1, failed: 0 });
    expect(w.store.get(creator.id)?.chatId).toBe(501);
  });
});

describe('runCounterpartyReview, indirect transfers', () => {
  const loop = (path: number[], amount: number): IndirectRow => ({
    userId: creator.id,
    path,
    amount,
  });

  it('files Buzz that came back through two other users for a moderator, without a warning', async () => {
    const w = world({ indirectRows: [loop([22, 33], 3_000)] });

    expect(await runCounterpartyReview(w.deps)).toEqual({
      pairs: 0,
      warned: 0,
      repeats: 0,
      failed: 0,
      indirect: 1,
    });

    expect(w.sendWarning).not.toHaveBeenCalled();
    expect(w.store.has(creator.id)).toBe(false);
    const [report] = w.reports;
    expect(() => abuseReportInput.parse(report)).not.toThrow();
    expect(report.findings).toEqual([
      expect.objectContaining({ userId: creator.id, confidence: 0.7, actioned: false }),
    ]);
    expect(report.findings[0]).not.toHaveProperty('action');
    expect(report.findings[0].reason).toContain('through accounts 22 → 33: 3,000 Buzz came back');
    expect(report.counters).toMatchObject({ indirect: 1 });
    expect(w.indirectStore.get(creator.id)).toEqual({ '22>33': 3_000 });
  });

  it('asks for two intermediaries by default, and three only when the setting allows it', async () => {
    const two = world();
    await runCounterpartyReview(two.deps);
    const asked = (w: ReturnType<typeof world>) =>
      w.ch.$query.mock.calls.map(([sql]) => sql as string).filter((s) => s.includes('AS path'));
    expect(asked(two)).toEqual([
      indirectTransfersSql({ since: BANKABLE_CUTOVER, min: MIN, intermediaries: 2 }),
    ]);

    const three = world({ maxIntermediaries: 3 });
    await runCounterpartyReview(three.deps);
    expect(asked(three)).toEqual([
      indirectTransfersSql({ since: BANKABLE_CUTOVER, min: MIN, intermediaries: 2 }),
      indirectTransfersSql({ since: BANKABLE_CUTOVER, min: MIN, intermediaries: 3 }),
    ]);

    // Out-of-range settings are clamped, never a query with no legs or an unbounded join.
    const high = world({ maxIntermediaries: 9 });
    await runCounterpartyReview(high.deps);
    expect(asked(high)).toHaveLength(2);
    const low = world({ maxIntermediaries: 1 });
    await runCounterpartyReview(low.deps);
    expect(asked(low)).toHaveLength(1);
  });

  it('files an indirect path again only for new paths or new volume of at least the minimum', async () => {
    const w = world({ indirectRows: [loop([22, 33], 3_000)] });
    await runCounterpartyReview(w.deps);

    w.setIndirectRows([loop([22, 33], 3_999)]);
    expect(await runCounterpartyReview(w.deps)).toMatchObject({ indirect: 0 });
    expect(w.reports.at(-1)!.findings).toEqual([]);

    w.setIndirectRows([loop([22, 33], 4_000)]);
    expect(await runCounterpartyReview(w.deps)).toMatchObject({ indirect: 1 });

    w.setIndirectRows([loop([22, 33], 4_000), loop([44, 55], 1_000)]);
    expect(await runCounterpartyReview(w.deps)).toMatchObject({ indirect: 1 });
    expect(w.indirectStore.get(creator.id)).toEqual({ '22>33': 4_000, '44>55': 1_000 });
    expect(w.sendWarning).not.toHaveBeenCalled();
  });

  it('files only current Creator Program members', async () => {
    const w = world({
      indirectRows: [loop([22, 33], 3_000), { userId: 99, path: [22, 33], amount: 3_000 }],
    });

    await runCounterpartyReview(w.deps);

    expect(w.reports[0].findings.map((f) => f.userId)).toEqual([creator.id]);
  });

  it('keeps an indirect path for the next run when the report carrying it fails', async () => {
    let failing = true;
    const w = world({ indirectRows: [loop([22, 33], 3_000)], reportFails: () => failing });

    await expect(runCounterpartyReview(w.deps)).rejects.toThrow('board unavailable');
    expect(w.indirectStore.has(creator.id)).toBe(false);

    failing = false;
    expect(await runCounterpartyReview(w.deps)).toMatchObject({ indirect: 1 });
  });
});

describe('indirectTransfersSql', () => {
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
  const sql = squash(
    indirectTransfersSql({ since: BANKABLE_CUTOVER, min: 1234.9, intermediaries: 2 })
  );

  // Pinned by clause: a wrong join key or a dropped filter still returns plausible rows.
  it('chains each leg from the payee of the one before, back to the creator as bankable earnings', () => {
    expect(sql).toContain('AS e2 ON e2.s2 = e1.p1');
    expect(sql).toContain('AS r ON r.rc = e1.s1 AND r.rp = e2.p2');
    expect(sql).toContain('SELECT e1.s1 AS userId, [e1.p1, e2.p2] AS path');
    expect(sql).toContain('least(e1.amt1, e2.amt2, r.ramt) AS amount');
  });

  it('holds every leg, the closing one too, to the minimum', () => {
    expect(sql.match(/WHERE amount >= 1234\b/g)).toHaveLength(3);
  });

  it('keeps every user on the path distinct, without NOT IN over joined columns', () => {
    expect(sql).toContain('WHERE e1.p1 != e1.s1 AND e2.p2 != e1.s1 AND e2.p2 != e1.p1 ORDER BY');
    expect(sql).not.toMatch(/NOT IN/);
  });

  it('adds a leg per intermediary', () => {
    const three = squash(
      indirectTransfersSql({ since: BANKABLE_CUTOVER, min: 1_000, intermediaries: 3 })
    );
    expect(three).toContain('AS e3 ON e3.s3 = e2.p2');
    expect(three).toContain('AS r ON r.rc = e1.s1 AND r.rp = e3.p3');
    expect(three).toContain('e3.p3 != e1.s1 AND e3.p3 != e1.p1 AND e3.p3 != e2.p2');
    expect(three).toContain(`LIMIT ${PAIR_CEILING}`);
  });
});

describe('renderWarningMessage', () => {
  it('is the one-time warning, naming the consequence', () => {
    const message = renderWarningMessage('creator_one');
    expect(message.startsWith('Hi creator\\_one,\n\n')).toBe(true);
    expect(message).toContain('Consider this your one and only warning.');
    expect(message).toContain('your account will be removed from the Creator Program');
    expect(message).toContain('[contact support](/support)');
  });

  it('escapes markdown in the username', () => {
    expect(renderWarningMessage('[x](http://a)*b*').split('\n')[0]).toBe(
      'Hi \\[x\\](http://a)\\*b\\*,'
    );
    expect(renderWarningMessage(null).split('\n')[0]).toBe('Hi there,');
  });
});

describe('counterpartyPairsSql', () => {
  // Pinned whole: a wrong join key or a dropped filter still returns plausible pairs.
  it('pairs bankable Buzz a creator received from a user with what the creator sent that user', () => {
    const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
    const since = "toDateTime('2026-11-01 00:00:00', 'UTC')";
    const earnedSince = `date >= ${since} AND toAccountId > 0 AND toAccountType IN (${buzzBankTypesSql})`;
    expect(squash(counterpartyPairsSql({ since: BANKABLE_CUTOVER, min: 1234.9 }))).toBe(
      squash(`
        SELECT received.recipient AS userId, received.payer AS counterpartyId,
          received.amount AS received, sent.amount AS sent
        FROM (${receivedFromUsersSql(earnedSince)}) AS received
        INNER JOIN (
          SELECT sender, payee, sum(amount) AS amount FROM (
            SELECT toInt64(fromAccountId) AS sender, toInt64(toAccountId) AS payee,
              toInt64(amount) AS amount
            FROM buzzTransactions
            WHERE date >= ${since} AND ${SENT_TO_USER_SQL}
            UNION ALL
            SELECT payer, recipient, amount FROM (${platformPaidFromUsersSql(earnedSince)})
          )
          GROUP BY sender, payee
        ) AS sent ON sent.sender = received.recipient AND sent.payee = received.payer
        WHERE received.payer != received.recipient
          AND least(received.amount, sent.amount) >= 1234
        ORDER BY least(received.amount, sent.amount) DESC
        LIMIT 10000`)
    );
  });
});
