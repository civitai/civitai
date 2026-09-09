import { TransactionType } from '~/shared/constants/buzz.constants';
import { PLACEMENT_LEDGER_DESCRIPTIONS } from '~/shared/utils/placement';
import { getDisplayName } from '~/utils/string-helpers';

/** Types whose descriptions are all written for the person reading them. */
const INCLUDE_DESCRIPTION: TransactionType[] = [TransactionType.Reward, TransactionType.Purchase];

/**
 * Descriptions a broader type may render, one string at a time.
 *
 * `Fee` covers both the placement escrow legs and the creator-program extraction
 * fee, and it also still holds rows written before #4212 that carry internal leg
 * names and a raw placement id. So the decision is made on the string rather
 * than the type: anything not written here is unrecognised and falls back to the
 * type name, which is what the dashboard already showed.
 */
const DESCRIPTION_ALLOWLIST: ReadonlySet<string> = new Set([
  ...PLACEMENT_LEDGER_DESCRIPTIONS,
  'Extraction fee',
]);

export const buzzTransactionLabel = ({
  type,
  description,
}: {
  type: TransactionType;
  description?: string | null;
}) =>
  description && (INCLUDE_DESCRIPTION.includes(type) || DESCRIPTION_ALLOWLIST.has(description))
    ? description
    : getDisplayName(TransactionType[type]);
