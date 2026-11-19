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
  return {
    items: rows.slice(0, limit).map((row) => ({
      ...row,
      evidence: summariseEvidence(row.evidence),
      decisions: decisionHistory(row.decisions),
    })),
    hasMore: rows.length > limit,
  };
}
