import { describe, expect, it, vi } from 'vitest';
import { abuseReportInput, type AbuseReportInput } from '@civitai/moderation';
import { BANKABLE_CUTOVER } from '~/shared/constants/creator-program.constants';
import { receivedFromUsersSql, SENT_TO_USER_SQL } from '~/server/services/creator-program-bankable';
import { buzzBankTypesSql } from '~/shared/constants/buzz.constants';
import {
  COUNTERPARTY_REVIEW_DETECTOR,
  counterpartyPairsSql,
  PAIR_CEILING,
  type Member,
} from '~/server/services/creator-program-counterparty-review/detect';
import {
  renderWarningMessage,
  WARNED_ACTION,
} from '~/server/services/creator-program-counterparty-review/report';
import {
  runCounterpartyReview,
  type ReviewDeps,
  type WarningRecord,
} from '~/server/services/creator-program-counterparty-review/run';

const MIN = 1_000;
const afterCutover = new Date('2026-12-01T10:00:00Z');
const creator: Member = { id: 11, username: 'creator_one' };

type Row = { userId: number; counterpartyId: number; received: number; sent: number };

/** One review world: a ClickHouse that returns `rows`, a members table, and a warnings store. */
function world({
  rows = [] as Row[],
  members = [creator],
  minimum = MIN as number | null,
  now = afterCutover,
  sendWarning = vi.fn(async () => ({ chatId: 500 })),
  reportFails = () => false,
} = {}) {
  const store = new Map<number, WarningRecord>();
  const reports: AbuseReportInput[] = [];
  const logs: { name: string; data: Record<string, unknown> }[] = [];
  const ch = { $query: vi.fn(async () => rows as never[]) };
  const deps: ReviewDeps = {
    ch,
    readMinimum: async () => minimum,
    findMembers: async (ids) => members.filter((m) => ids.includes(m.id)),
    warnings: {
      get: async (id) => store.get(id) ?? null,
      set: async (id, record) => void store.set(id, record),
    },
    sendWarning,
    sendReport: async (report) => {
      if (reportFails()) throw new Error('board unavailable');
      reports.push(report);
    },
    now: () => now,
    log: (name, data) => void logs.push({ name, data }),
  };
  return { deps, ch, store, reports, logs, sendWarning, setRows: (r: Row[]) => (rows = r) };
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

  it('reads the supporters of awarded bounties into the pairs it files', async () => {
    const w = world();
    w.ch.$query.mockImplementation(async (sql: string) => {
      if (sql.includes('AS counterpartyId'))
        return (sql.includes('(7, 99, 5000, 5000)') ? [pair(99, 5_000, 5_000)] : []) as never[];
      return [{ bountyId: 7 }] as never[];
    });
    w.deps.findBountyFunders = async (ids) =>
      ids.includes(7) ? [{ bountyId: 7, userId: 99, unitAmount: 5_000, total: 5_000 }] : [];

    await runCounterpartyReview(w.deps);

    expect(w.reports[0].findings.map((f) => f.reason).join('\n')).toContain('with account 99');
  });

  it('does not warn again, or file again, when nothing new happened', async () => {
    const w = world({ rows: [pair(22, 5_000, 4_000)] });
    await runCounterpartyReview(w.deps);

    expect(await runCounterpartyReview(w.deps)).toEqual({
      pairs: 1,
      warned: 0,
      repeats: 0,
      failed: 0,
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
    const since = "'2026-11-01 00:00:00'";
    expect(squash(counterpartyPairsSql({ since: BANKABLE_CUTOVER, min: 1234.9 }))).toBe(
      squash(`
        SELECT received.recipient AS userId, received.payer AS counterpartyId,
          received.amount AS received, sent.amount AS sent
        FROM (${receivedFromUsersSql(
          `date >= ${since} AND toAccountId > 0 AND toAccountType IN (${buzzBankTypesSql})`,
          []
        )}) AS received
        INNER JOIN (
          SELECT toInt64(fromAccountId) AS sender, toInt64(toAccountId) AS payee,
            toInt64(sum(amount)) AS amount
          FROM buzzTransactions
          WHERE date >= ${since} AND ${SENT_TO_USER_SQL}
          GROUP BY sender, payee
        ) AS sent ON sent.sender = received.recipient AND sent.payee = received.payer
        WHERE received.payer != received.recipient
          AND least(received.amount, sent.amount) >= 1234
        ORDER BY least(received.amount, sent.amount) DESC
        LIMIT 10000`)
    );
  });
});
