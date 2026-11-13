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
import { renderSummary, toFinding, toIndirectFinding } from './report';

type Finding = AbuseReportInput['findings'][number];

export type FiledRecord = {
  filedAt: string;
  /** Two-way amount per counterparty when the creator was last filed. */
  counterparties: Record<string, number>;
};

/** Entries written while the review still messaged creators carry `warnedAt` instead of `filedAt`. */
export function parseFiledRecord(raw: string | null | undefined): FiledRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<FiledRecord> & { warnedAt?: string };
    const filedAt = parsed.filedAt ?? parsed.warnedAt;
    if (!filedAt || !parsed.counterparties) return null;
    return { filedAt, counterparties: parsed.counterparties };
  } catch {
    return null;
  }
}

/** Amount per indirect path when it was last filed, keyed by `pathKey`. */
export type IndirectRecord = Record<string, number>;

export const pathKey = (t: IndirectTransfer) => t.path.join('>');

export type ReviewDeps = {
  ch: ReviewClickhouse | null;
  /** The smallest two-way amount to file, or null when ops has not set one. */
  readMinimum: () => Promise<number | null>;
  readMaxIntermediaries: () => Promise<number>;
  findMembers: (ids: number[]) => Promise<Member[]>;
  filed: {
    get: (userId: number) => Promise<FiledRecord | null>;
    set: (userId: number, record: FiledRecord) => Promise<void>;
  };
  indirect: {
    get: (userId: number) => Promise<IndirectRecord | null>;
    set: (userId: number, record: IndirectRecord) => Promise<void>;
  };
  sendReport: (report: AbuseReportInput) => Promise<unknown>;
  now: () => Date;
  log?: (name: string, data: Record<string, unknown>) => void;
};

export type ReviewResult = {
  pairs: number;
  filed: number;
  repeats: number;
  indirect: number;
  skipped?: 'before-cutover' | 'minimum-not-set' | 'clickhouse-unavailable';
};

const twoWay = (p: CounterpartyPair) => Math.min(p.received, p.sent);

export async function runCounterpartyReview(deps: ReviewDeps): Promise<ReviewResult> {
  const startedAt = deps.now();
  const empty = { pairs: 0, filed: 0, repeats: 0, indirect: 0 };

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
  // A failed search costs only the indirect findings; the direct ones are still filed.
  const transfers: IndirectTransfer[] = [];
  try {
    const maxIntermediaries = Math.min(
      MAX_INTERMEDIARIES,
      Math.max(DEFAULT_MAX_INTERMEDIARIES, Math.trunc(await deps.readMaxIntermediaries()) || 0)
    );
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

  // Which indirect paths to file. A member with a direct finding gets these in it rather than a
  // second finding.
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

  const filedEarlier = new Map<number, Date>();
  // Saved only once the report carrying the finding has been filed: saved earlier, a failed report
  // would lose the finding for good, since the next run would see no new volume.
  const filedRecords = new Map<number, { record: FiledRecord; finding: Finding }>();
  let filed = 0;
  let repeats = 0;

  for (const member of members) {
    const memberPairs = byUser.get(member.id) ?? [];
    const current = Object.fromEntries(
      memberPairs.map((p) => [String(p.counterpartyId), twoWay(p)])
    );
    const record = await deps.filed.get(member.id);

    // Already filed: file again only for new volume of at least the minimum on some pair.
    if (
      record &&
      !memberPairs.some(
        (p) => twoWay(p) - (record.counterparties[String(p.counterpartyId)] ?? 0) >= min
      )
    ) {
      filedEarlier.set(member.id, new Date(record.filedAt));
      continue;
    }

    const finding = file(
      member.id,
      toFinding(
        member.id,
        memberPairs,
        record ? new Date(record.filedAt) : null,
        BANKABLE_CUTOVER,
        indirectDue.get(member.id)?.transfers
      )
    );
    filedRecords.set(member.id, {
      record: {
        filedAt: record?.filedAt ?? startedAt.toISOString(),
        counterparties: { ...record?.counterparties, ...current },
      },
      finding,
    });
    if (record) repeats++;
    else filed++;
  }

  // The rest are filed with only their indirect transfers.
  for (const [userId, { transfers: memberTransfers }] of indirectDue)
    if (!indirectRecords.has(userId))
      file(
        userId,
        toIndirectFinding(userId, memberTransfers, BANKABLE_CUTOVER, filedEarlier.get(userId))
      );

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
      filed,
      repeats,
      indirect,
    }),
    counters: {
      pairs: pairs.length,
      members: members.length,
      filed,
      repeats,
      indirect,
    },
    findings,
  });
  // By finding, not member: one member can have a finding that survived the cut and one that did not.
  for (const [userId, { record, finding }] of filedRecords)
    if (findings.includes(finding))
      await deps.filed.set(userId, record).catch((e: Error) =>
        deps.log?.('creator-program-counterparty-review-record-failed', {
          userId,
          error: e.message,
        })
      );
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
    filed,
    repeats,
    indirect,
  });

  return { pairs: pairs.length, filed, repeats, indirect };
}
