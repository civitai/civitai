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

type Finding = AbuseReportInput['findings'][number];

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
  // Read before any warning goes out: a failure after that would leave warned members unfiled.
  // A failed search costs only the indirect findings; the direct ones are still filed.
  const maxIntermediaries = Math.min(
    MAX_INTERMEDIARIES,
    Math.max(DEFAULT_MAX_INTERMEDIARIES, Math.trunc(await deps.readMaxIntermediaries()) || 0)
  );
  const transfers: IndirectTransfer[] = [];
  try {
    for (let n = DEFAULT_MAX_INTERMEDIARIES; n <= maxIntermediaries; n++) {
      const found = await findIndirectTransfers(deps.ch, {
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
  } catch (e) {
    transfers.length = 0;
    deps.log?.('creator-program-counterparty-review-indirect-failed', {
      error: (e as Error).message,
    });
  }

  const byUser = new Map<number, CounterpartyPair[]>();
  for (const pair of pairs) byUser.set(pair.userId, [...(byUser.get(pair.userId) ?? []), pair]);
  const transfersByUser = new Map<number, IndirectTransfer[]>();
  for (const t of transfers)
    transfersByUser.set(t.userId, [...(transfersByUser.get(t.userId) ?? []), t]);
  const allMembers = await deps.findMembers([
    ...new Set([...byUser.keys(), ...transfersByUser.keys()]),
  ]);
  const members = allMembers.filter((m) => byUser.has(m.id));

  // Which indirect paths to file, also decided before any warning goes out. A member with a direct
  // finding gets these in it rather than a second finding.
  const indirectDue = new Map<number, { transfers: IndirectTransfer[]; record: IndirectRecord }>();
  try {
    for (const member of allMembers) {
      const memberTransfers = transfersByUser.get(member.id);
      if (!memberTransfers) continue;
      const record = (await deps.indirect.get(member.id)) ?? {};
      if (!memberTransfers.some((t) => t.amount - (record[pathKey(t)] ?? 0) >= min)) continue;
      indirectDue.set(member.id, {
        transfers: memberTransfers,
        record: {
          ...record,
          ...Object.fromEntries(memberTransfers.map((t) => [pathKey(t), t.amount])),
        },
      });
    }
  } catch (e) {
    indirectDue.clear();
    deps.log?.('creator-program-counterparty-review-indirect-failed', {
      error: (e as Error).message,
    });
  }
  const findings: AbuseReportInput['findings'] = [];
  const indirectRecords = new Map<number, { record: IndirectRecord; finding: Finding }>();
  const file = (userId: number, finding: Finding) => {
    findings.push(finding);
    const due = indirectDue.get(userId);
    if (due) indirectRecords.set(userId, { record: due.record, finding });
    return finding;
  };

  // Saved only once the report carrying the repeat has been filed: saved earlier, a failed report
  // would lose the repeat for good, since the next run would see no new volume.
  const repeatRecords = new Map<number, { record: WarningRecord; finding: Finding }>();
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
      file(
        member.id,
        toFinding(
          member.id,
          memberPairs,
          outcome,
          BANKABLE_CUTOVER,
          indirectDue.get(member.id)?.transfers
        )
      );
      continue;
    }

    // Already warned: file again only for new volume of at least the minimum on some pair.
    const grew = memberPairs.filter(
      (p) => twoWay(p) - (record.counterparties[String(p.counterpartyId)] ?? 0) >= min
    );
    if (!grew.length) continue;

    const finding = file(
      member.id,
      toFinding(
        member.id,
        memberPairs,
        { kind: 'repeat', warnedAt: new Date(record.warnedAt) },
        BANKABLE_CUTOVER,
        indirectDue.get(member.id)?.transfers
      )
    );
    repeatRecords.set(member.id, {
      record: { ...record, counterparties: { ...record.counterparties, ...current } },
      finding,
    });
    repeats++;
  }

  // The rest are filed for a moderator only: no warning message, since more innocent patterns look
  // like this.
  for (const [userId, { transfers: memberTransfers }] of indirectDue)
    if (!indirectRecords.has(userId))
      file(userId, toIndirectFinding(userId, memberTransfers, BANKABLE_CUTOVER));

  findings.sort((a, b) => b.confidence - a.confidence);
  findings.splice(MAX_FINDINGS_PER_REPORT);
  const indirect = [...indirectRecords.values()].filter(({ finding }) =>
    findings.includes(finding)
  ).length;

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
  // By finding, not member: one member can have a finding that survived the cut and one that did not.
  for (const [userId, { record, finding }] of repeatRecords)
    if (findings.includes(finding)) await deps.warnings.set(userId, record);
  for (const [userId, { record, finding }] of indirectRecords)
    if (findings.includes(finding))
      await deps.indirect.set(userId, record).catch((e: Error) =>
        deps.log?.('creator-program-counterparty-review-record-failed', {
          userId,
          error: e.message,
        })
      );

  deps.log?.('creator-program-counterparty-review-reported', {
    pairs: pairs.length,
    warned,
    repeats,
    failed,
    indirect,
  });

  return { pairs: pairs.length, warned, repeats, failed, indirect };
}
