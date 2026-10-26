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
