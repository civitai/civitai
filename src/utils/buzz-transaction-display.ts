import {
  GENERATION_TIP_TRANSACTION_PREFIX,
  TransactionType,
} from '~/shared/constants/buzz.constants';

// Generation tips are stored as Compensation (peak/pool accounting reads that type), so the
// transactions page tells them apart by the externalTransactionId prefix, display only.
export const GENERATION_TIP_LABEL = 'Tip';
export const GENERATION_TIP_FILTER = 'Generation tip';

type DisplayRow = { type: TransactionType; externalTransactionId?: string | null };

export function isGenerationTip(row: DisplayRow) {
  return (
    row.type === TransactionType.Compensation &&
    !!row.externalTransactionId?.startsWith(GENERATION_TIP_TRANSACTION_PREFIX)
  );
}

export function getTransactionBadgeLabel(row: DisplayRow) {
  return isGenerationTip(row) ? GENERATION_TIP_LABEL : TransactionType[row.type];
}

// The good/collected-content rewards are stored as "Buzz Reward: Content that you posted was
// liked/collected…" (base.reward.ts adds the prefix), and the page rewrites "Content" to name the
// entity. Matched as that exact phrase: an unanchored 'Content' rewrote model names too, e.g.
// "AI chat: ContentWriter" became "AI chat: A userWriter".
const LEADING_CONTENT = /^(Buzz Reward: )?Content(?= that you posted )/;

/**
 * The description line for a row. A merged workflow row is its charge, so it shows the charge's
 * description; the refund's own text goes with the refund row.
 */
export function getTransactionDescription(row: { description?: string | null }, label?: string) {
  const description = row.description || undefined;
  if (!description || !label) return description;
  return description.replace(
    LEADING_CONTENT,
    (_match, prefix?: string) => `${prefix ?? ''}A ${label.toLowerCase()}`
  );
}

/** "+11" for a credit, "-12" for a debit, and a plain "0" for a fully refunded workflow. */
export function formatSignedAmount(amount: number) {
  return `${amount > 0 ? '+' : ''}${amount.toLocaleString()}`;
}

// ── One row per orchestration workflow ───────────────────────────────────────
// A workflow is charged up front as a Generation (details.workflowId) and later partly refunded as a
// Refund naming the same workflow, so a cheap chat used to list a "Generation -12" and a "Refund +11"
// per model step. The page folds the two into one net row. Display only: the API response and the
// CSV export still carry both gross legs.

export type WorkflowRefund = { grossAmount: number; refundAmount: number; refundDate: Date };

type PairableRow = DisplayRow & {
  date: Date;
  amount: number;
  fromAccountId: number;
  toAccountId: number;
  fromAccountType: string;
  toAccountType: string;
  details?: Record<string, unknown> | null;
};

function detailsWorkflowId(row: PairableRow) {
  const id = row.details?.workflowId;
  return typeof id === 'string' && id ? id : undefined;
}

// The identity both legs must share exactly: the workflow, the account the Buzz left and came back
// to, and the currency it moved in.
function pairKey(workflowId: string, accountId: number, accountType: string) {
  return JSON.stringify([workflowId, accountId, accountType]);
}

function chargeKey(row: PairableRow) {
  if (row.type !== TransactionType.Generation || row.amount >= 0) return undefined;
  const workflowId = detailsWorkflowId(row);
  return workflowId && pairKey(workflowId, row.fromAccountId, row.fromAccountType);
}

function refundKey(row: PairableRow) {
  if (row.type !== TransactionType.Refund || row.amount <= 0) return undefined;
  // Every orchestration refund carries details.workflowId; its external id names the account TYPE,
  // not the account, so it is not an identity here.
  const workflowId = detailsWorkflowId(row);
  return workflowId && pairKey(workflowId, row.toAccountId, row.toAccountType);
}

/**
 * Folds each workflow's Refund into its Generation charge: one row, at the charge's position and
 * time, carrying the net amount and both gross legs. Pairs only when exactly one charge and exactly
 * one refund share the identity; anything else is returned untouched (the same object).
 */
export function mergeWorkflowRefunds<T extends PairableRow>(
  rows: T[]
): Array<T & { workflowRefund?: WorkflowRefund }> {
  const charges = new Map<string, T[]>();
  const refunds = new Map<string, T[]>();
  for (const row of rows) {
    const asCharge = chargeKey(row);
    if (asCharge) charges.set(asCharge, [...(charges.get(asCharge) ?? []), row]);
    const asRefund = refundKey(row);
    if (asRefund) refunds.set(asRefund, [...(refunds.get(asRefund) ?? []), row]);
  }

  const refundFor = new Map<T, T>();
  const absorbed = new Set<T>();
  for (const [key, matchedCharges] of charges) {
    const matchedRefunds = refunds.get(key);
    if (matchedCharges.length !== 1 || !matchedRefunds || matchedRefunds.length !== 1) continue;
    const [charge] = matchedCharges;
    const [refund] = matchedRefunds;
    refundFor.set(charge, refund);
    absorbed.add(refund);
  }

  return rows.flatMap((row) => {
    if (absorbed.has(row)) return [];
    const refund = refundFor.get(row);
    if (!refund) return [row];
    return [
      {
        ...row,
        amount: row.amount + refund.amount,
        workflowRefund: {
          grossAmount: row.amount,
          refundAmount: refund.amount,
          refundDate: refund.date,
        },
      },
    ];
  });
}

/** Merges within each fetched page only, so a pair split across pages renders as its two halves. */
export function mergeWorkflowRefundsByPage<T extends PairableRow>(pages: T[][]) {
  return pages.flatMap((page) => mergeWorkflowRefunds(page));
}

/** Rows to show for a type-filter choice. Compensation hides tips; the tip choice shows only tips. */
export function filterTransactionsByDisplayType<T extends DisplayRow>(
  rows: T[],
  selected: string | null
) {
  if (selected === GENERATION_TIP_FILTER) return rows.filter(isGenerationTip);
  if (selected === TransactionType[TransactionType.Compensation])
    return rows.filter((row) => !isGenerationTip(row));
  return rows;
}

/** The server filters by stored type, so the tip choice queries Compensation and narrows client side. */
export function getServerTransactionType(selected: string | null) {
  if (selected == null) return undefined;
  if (selected === GENERATION_TIP_FILTER) return TransactionType.Compensation;
  return TransactionType[selected as keyof typeof TransactionType];
}
