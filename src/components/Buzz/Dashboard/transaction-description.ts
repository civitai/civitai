import { EXTRACTION_FEE_DESCRIPTION } from '~/shared/constants/creator-program.constants';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { PLACEMENT_LEDGER_DESCRIPTIONS } from '~/shared/utils/placement';
import { getDisplayName } from '~/utils/string-helpers';

/** Types whose descriptions are all written for the person reading them. */
const INCLUDE_DESCRIPTION: TransactionType[] = [TransactionType.Reward, TransactionType.Purchase];

/**
 * `Fee` also holds rows written before #4212 that carry internal leg names and a
 * raw placement id, so fee copy is allowlisted by string rather than by type.
 */
const DESCRIPTION_ALLOWLIST: ReadonlySet<string> = new Set([
  ...PLACEMENT_LEDGER_DESCRIPTIONS,
  EXTRACTION_FEE_DESCRIPTION,
]);

/**
 * The allowlist is checked only on `Fee`, not on any type carrying a matching
 * string: a tip's description is written by the tipper (`tipUser` spreads it into
 * the row), so a type-agnostic check would let one buy a system-voice line in
 * someone else's ledger.
 */
export const buzzTransactionLabel = ({
  type,
  description,
}: {
  type: TransactionType;
  description?: string | null;
}) =>
  description &&
  (INCLUDE_DESCRIPTION.includes(type) ||
    (type === TransactionType.Fee && DESCRIPTION_ALLOWLIST.has(description)))
    ? description
    : getDisplayName(TransactionType[type]);
