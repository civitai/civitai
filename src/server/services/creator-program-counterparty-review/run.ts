import { MAX_FINDINGS_PER_REPORT, type AbuseReportInput } from '@civitai/moderation';
import { BANKABLE_CUTOVER } from '~/shared/constants/creator-program.constants';
import {
  COUNTERPARTY_REVIEW_DETECTOR,
  DEFAULT_MAX_INTERMEDIARIES,
  findCounterpartyPairs,
  findIndirectTransfers,
  MAX_INTERMEDIARIES,
  PAIR_CEILING,
  type CounterpartyPair,
  type IndirectTransfer,
  type Member,
  type ReviewClickhouse,
} from './detect';
import { renderSummary, toFinding, toIndirectFinding, type ReviewOutcome } from './report';

export type WarningRecord = {
  warnedAt: string;
  chatId: number;
  /** Two-way amount per counterparty when the creator was last filed. */
  counterparties: Record<string, number>;
};

/** Amount per indirect path when it was last filed, keyed by `pathKey`. */
export type IndirectRecord = Record<string, number>;

export const pathKey = (t: IndirectTransfer) => t.path.join('>');

export type ReviewDeps = {
  ch: ReviewClickhouse | null;
  /** The smallest two-way amount to file, or null when ops has not set one. */
  readMinimum: () => Promise<number | null>;
  readMaxIntermediaries: () => Promise<number>;
  findMembers: (ids: number[]) => Promise<Member[]>;
  warnings: {
    get: (userId: number) => Promise<WarningRecord | null>;
    set: (userId: number, record: WarningRecord) => Promise<void>;
  };
  indirect: {
    get: (userId: number) => Promise<IndirectRecord | null>;
    set: (userId: number, record: IndirectRecord) => Promise<void>;
  };
  sendWarning: (member: Member) => Promise<{ chatId: number }>;
  sendReport: (report: AbuseReportInput) => Promise<unknown>;
  now: () => Date;
  log?: (name: string, data: Record<string, unknown>) => void;
};

export type ReviewResult = {
  pairs: number;
  warned: number;
  repeats: number;
  failed: number;
  indirect: number;
  skipped?: 'before-cutover' | 'minimum-not-set' | 'clickhouse-unavailable';
};

const twoWay = (p: CounterpartyPair) => Math.min(p.received, p.sent);

export async function runCounterpartyReview(deps: ReviewDeps): Promise<ReviewResult> {
  const startedAt = deps.now();
  const empty = { pairs: 0, warned: 0, repeats: 0, failed: 0, indirect: 0 };

  // Before the cutover every yellow and green Buzz is bankable, so an exchange gains nothing.
  if (startedAt < BANKABLE_CUTOVER) return { ...empty, skipped: 'before-cutover' };

  const min = await deps.readMinimum();
  if (min === null) {
    // Logged every run so an unset minimum cannot leave the review silently off.
    deps.log?.('creator-program-counterparty-review-skipped', {
      reason: 'minimum not set, skipping',
    });
    return { ...empty, skipped: 'minimum-not-set' };
  }
  if (!deps.ch) {
    deps.log?.('creator-program-counterparty-review-skipped', { reason: 'clickhouse-unavailable' });
    return { ...empty, skipped: 'clickhouse-unavailable' };
  }

  const pairs = await findCounterpartyPairs(deps.ch, { since: BANKABLE_CUTOVER, min });
  if (pairs.length >= PAIR_CEILING)
    deps.log?.('creator-program-counterparty-review-ceiling', { pairs: pairs.length });
  const byUser = new Map<number, CounterpartyPair[]>();
  for (const pair of pairs) byUser.set(pair.userId, [...(byUser.get(pair.userId) ?? []), pair]);
  const members = await deps.findMembers([...byUser.keys()]);

  const findings: AbuseReportInput['findings'] = [];
  // Saved only once the report carrying the repeat has been filed: saved earlier, a failed report
  // would lose the repeat for good, since the next run would see no new volume.
  const repeatRecords = new Map<number, WarningRecord>();
  let warned = 0;
  let repeats = 0;
  let failed = 0;

  for (const member of members) {
    const memberPairs = byUser.get(member.id) ?? [];
    const current = Object.fromEntries(
      memberPairs.map((p) => [String(p.counterpartyId), twoWay(p)])
    );
    const record = await deps.warnings.get(member.id);

    if (!record) {
      let outcome: ReviewOutcome;
      try {
        const { chatId } = await deps.sendWarning(member);
        outcome = { kind: 'warned', chatId };
        warned++;
      } catch (e) {
        outcome = { kind: 'warning-failed', error: (e as Error).message };
        failed++;
        deps.log?.('creator-program-counterparty-review-warning-failed', {
          userId: member.id,
          error: (e as Error).message,
        });
      }
      if (outcome.kind === 'warned') {
        // A record that fails to save means the next run warns again, so it is logged on its own.
        await deps.warnings
          .set(member.id, {
            warnedAt: startedAt.toISOString(),
            chatId: outcome.chatId,
            counterparties: current,
          })
          .catch((e: Error) =>
            deps.log?.('creator-program-counterparty-review-record-failed', {
              userId: member.id,
              error: e.message,
            })
          );
      }
      findings.push(toFinding(member.id, memberPairs, outcome, BANKABLE_CUTOVER));
      continue;
    }

    // Already warned: file again only for new volume of at least the minimum on some pair.
    const grew = memberPairs.filter(
      (p) => twoWay(p) - (record.counterparties[String(p.counterpartyId)] ?? 0) >= min
    );
    if (!grew.length) continue;

    repeatRecords.set(member.id, {
      ...record,
      counterparties: { ...record.counterparties, ...current },
    });
    findings.push(
      toFinding(
        member.id,
        memberPairs,
        { kind: 'repeat', warnedAt: new Date(record.warnedAt) },
        BANKABLE_CUTOVER
      )
    );
    repeats++;
  }

  // Filed for a moderator only: no warning message, since more innocent patterns look like this.
  const maxIntermediaries = Math.min(
    MAX_INTERMEDIARIES,
    Math.max(DEFAULT_MAX_INTERMEDIARIES, Math.trunc(await deps.readMaxIntermediaries()) || 0)
  );
  const ch = deps.ch;
  const transfers: IndirectTransfer[] = [];
  for (let n = DEFAULT_MAX_INTERMEDIARIES; n <= maxIntermediaries; n++) {
    const found = await findIndirectTransfers(ch, {
      since: BANKABLE_CUTOVER,
      min,
      intermediaries: n,
    });
    if (found.length >= PAIR_CEILING)
      deps.log?.('creator-program-counterparty-review-ceiling', {
        intermediaries: n,
        transfers: found.length,
      });
    transfers.push(...found);
  }
  const transfersByUser = new Map<number, IndirectTransfer[]>();
  for (const t of transfers)
    transfersByUser.set(t.userId, [...(transfersByUser.get(t.userId) ?? []), t]);
  const indirectRecords = new Map<
    number,
    { record: IndirectRecord; finding: AbuseReportInput['findings'][number] }
  >();
  const indirectMembers = transfersByUser.size
    ? await deps.findMembers([...transfersByUser.keys()])
    : [];
  for (const member of indirectMembers) {
    const memberTransfers = transfersByUser.get(member.id) ?? [];
    const record = (await deps.indirect.get(member.id)) ?? {};
    const grew = memberTransfers.filter((t) => t.amount - (record[pathKey(t)] ?? 0) >= min);
    if (!grew.length) continue;

    const finding = toIndirectFinding(member.id, memberTransfers, BANKABLE_CUTOVER);
    findings.push(finding);
    indirectRecords.set(member.id, {
      record: {
        ...record,
        ...Object.fromEntries(memberTransfers.map((t) => [pathKey(t), t.amount])),
      },
      finding,
    });
  }
  const indirect = indirectRecords.size;

  findings.sort((a, b) => b.confidence - a.confidence);
  findings.splice(MAX_FINDINGS_PER_REPORT);

  // Filed with no findings too: a run row is how the board shows the review ran.
  await deps.sendReport({
    detector: COUNTERPARTY_REVIEW_DETECTOR,
    startedAt: startedAt.toISOString(),
    finishedAt: deps.now().toISOString(),
    summary: renderSummary({
      pairs: pairs.length,
      members: members.length,
      warned,
      repeats,
      failed,
      indirect,
    }),
    counters: {
      pairs: pairs.length,
      members: members.length,
      warned,
      repeats,
      failed,
      indirect,
    },
    findings,
  });
  const filed = new Set(findings.map((f) => f.userId));
  for (const [userId, record] of repeatRecords)
    if (filed.has(userId)) await deps.warnings.set(userId, record);
  // Its own finding, not the member's: a direct finding can survive the cut while this one did not.
  for (const [userId, { record, finding }] of indirectRecords)
    if (findings.includes(finding)) await deps.indirect.set(userId, record);

  deps.log?.('creator-program-counterparty-review-reported', {
    pairs: pairs.length,
    warned,
    repeats,
    failed,
    indirect,
  });

  return { pairs: pairs.length, warned, repeats, failed, indirect };
}
