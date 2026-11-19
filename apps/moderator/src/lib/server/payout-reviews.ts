import { dbWrite } from './db';

export const HOLDING_STATUSES = ['open', 'escalated', 'withheld'] as const;
export type PayoutReviewView = 'holding' | 'cleared';

/** Settlement (`creatorsProgramSettleCash`, `0 0 15 * *`) pays every creator whose latest review is
 *  cleared, so a clear made after the most recent 15th 00:00 UTC has not been paid yet. */
export function lastSettlementAt(now: Date): Date {
  const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15));
  return now >= thisMonth
    ? thisMonth
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
}

export type EvidenceSummary = {
  signals: { name: string; value: number; limit: number; counterpartyId: number | null }[];
  payoutCents: number | null;
  bankable: number | null;
  priorPayoutsCents: number[];
  exchangeCount: number;
  manual: { ground: string; reason: string } | null;
};

export type PayoutReviewDecisionEntry = {
  at: string;
  by: string;
  action: string;
  from: string;
  to: string;
  version: number | null;
  note: string | null;
  askRef: string | null;
  ground: string | null;
};

export type PayoutReviewRow = {
  id: number;
  period: string;
  userId: number;
  username: string | null;
  status: string;
  signals: string[];
  payoutCents: number;
  evidence: EvidenceSummary;
  decisions: PayoutReviewDecisionEntry[];
  version: number;
  askRef: string | null;
  decidedAt: Date | null;
  decidedBy: string | null;
  firstFlaggedAt: Date;
  hold: boolean;
  /** Whether settlement leaves this creator's pending cash out because of this row. */
  holdsPayout: boolean;
  /** The creator's newer period, when this row is no longer the one a withhold or clear counts on. */
  supersededBy: string | null;
  decidable: boolean;
};

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === 'string' ? v : null);

/** Field by field, never a spread: `evidence` is written by the detector and grows, and only what a
 *  decision needs may reach the page. */
export function summariseEvidence(raw: unknown): EvidenceSummary {
  const evidence = record(raw);
  const manual = record(evidence.manual);
  return {
    signals: Object.entries(record(evidence.signals)).map(([name, detail]) => {
      const d = record(detail);
      return {
        name,
        value: num(d.value) ?? 0,
        limit: num(d.limit) ?? 0,
        counterpartyId: num(d.counterpartyId),
      };
    }),
    payoutCents: num(evidence.payoutCents),
    bankable: num(evidence.bankable),
    priorPayoutsCents: Array.isArray(evidence.priorPayoutsCents)
      ? evidence.priorPayoutsCents.filter((v): v is number => num(v) !== null)
      : [],
    exchangeCount: Array.isArray(evidence.exchanges) ? evidence.exchanges.length : 0,
    manual:
      str(manual.ground) !== null
        ? { ground: str(manual.ground) as string, reason: str(manual.reason) ?? '' }
        : null,
  };
}

export function decisionHistory(raw: unknown): PayoutReviewDecisionEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((value) => {
    const e = record(value);
    return {
      at: str(e.at) ?? '',
      by: str(e.by) ?? '',
      action: str(e.action) ?? '',
      from: str(e.from) ?? '',
      to: str(e.to) ?? '',
      version: num(e.version),
      note: str(e.note),
      askRef: str(e.askRef),
      ground: str(e.ground),
    };
  });
}

type SettlementRow = { userId: number; period: string; status: string; hold: boolean };

/** `resolveHolds` in src/server/services/creator-program-prepayout-review/hold.ts, which settlement
 *  reads: an open or escalated review holds in any period while `hold` is set, but a withhold or a
 *  clear counts only on the creator's latest period. */
export function settlementState(rows: SettlementRow[]) {
  const latest = new Map<number, string>();
  for (const r of rows) {
    const seen = latest.get(r.userId);
    if (!seen || r.period > seen) latest.set(r.userId, r.period);
  }
  const isLatest = (r: SettlementRow) => latest.get(r.userId) === r.period;
  const holds = (r: SettlementRow) =>
    (r.hold && (r.status === 'open' || r.status === 'escalated')) ||
    (r.status === 'withheld' && isLatest(r));
  const heldUserIds = new Set(rows.filter(holds).map((r) => r.userId));
  return { latest, isLatest, holds, heldUserIds };
}

/** Reads the primary: a decision bumps `version`, and a lagging replica would hand the next decision
 *  the old one, which the endpoint refuses. */
export async function listPayoutReviews(
  view: PayoutReviewView,
  { now = new Date(), limit = 200 }: { now?: Date; limit?: number } = {}
): Promise<{ items: PayoutReviewRow[]; hasMore: boolean }> {
  let query = dbWrite
    .selectFrom('CreatorProgramPayoutReview as r')
    .leftJoin('User as u', 'u.id', 'r.userId')
    .select([
      'r.id',
      'r.period',
      'r.userId',
      'u.username',
      'r.status',
      'r.hold',
      'r.signals',
      'r.payoutCents',
      'r.evidence',
      'r.decisions',
      'r.version',
      'r.askRef',
      'r.decidedAt',
      'r.decidedBy',
      'r.firstFlaggedAt',
    ]);
  query =
    view === 'holding'
      ? query
          .where('r.status', 'in', [...HOLDING_STATUSES])
          .orderBy('r.period', 'desc')
          .orderBy('r.firstFlaggedAt', 'asc')
      : query
          .where('r.status', '=', 'cleared')
          .where('r.decidedAt', '>', lastSettlementAt(now))
          .orderBy('r.decidedAt', 'desc');
  const rows = await query
    .orderBy('r.id', 'asc')
    .limit(limit + 1)
    .execute();

  const userIds = [...new Set(rows.map((r) => r.userId))];
  const related = userIds.length
    ? await dbWrite
        .selectFrom('CreatorProgramPayoutReview')
        .select(['userId', 'period', 'status', 'hold'])
        .where('userId', 'in', userIds)
        .execute()
    : [];
  const state = settlementState(related);

  const items = rows.slice(0, limit).flatMap((row): PayoutReviewRow[] => {
    const latestPeriod = state.latest.get(row.userId) ?? row.period;
    const isLatest = latestPeriod === row.period;
    const holdsPayout = state.holds(row);
    // Only a clear the next settlement will act on belongs in this view.
    if (view === 'cleared' && (!isLatest || state.heldUserIds.has(row.userId))) return [];
    return [
      {
        ...row,
        evidence: summariseEvidence(row.evidence),
        decisions: decisionHistory(row.decisions),
        holdsPayout,
        supersededBy: isLatest ? null : latestPeriod,
        // A superseded row that holds nothing changes nothing at settlement when decided.
        decidable: holdsPayout || isLatest,
      },
    ];
  });
  return { items, hasMore: rows.length > limit };
}
