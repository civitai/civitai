import { buzzBulkBonusMultipliers } from '~/server/common/constants';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import type { FeatureAccess } from '~/server/services/feature-flags.service';

export const getBuzzBulkMultiplier = ({
  buzzAmount: _buzzAmount,
  purchasesMultiplier,
}: {
  buzzAmount: number;
  purchasesMultiplier: number;
}) => {
  const buzzAmount = Number(_buzzAmount);
  const bulkBuzzMultiplier = buzzBulkBonusMultipliers.reduce((acc, [amount, multiplier]) => {
    if (buzzAmount >= amount) {
      return multiplier;
    }

    return acc;
  }, 1);

  const mainBuzzAdded = Math.floor(buzzAmount * purchasesMultiplier - buzzAmount);
  const blueBuzzAdded = Math.max(
    Math.floor(buzzAmount * bulkBuzzMultiplier - mainBuzzAdded - buzzAmount),
    0
  );

  return {
    buzzAmount,
    purchasesMultiplier,
    bulkBuzzMultiplier,
    blueBuzzAdded,
    mainBuzzAdded,
    totalBlueBuzz: blueBuzzAdded,
    totalCustomBuzz: mainBuzzAdded + buzzAmount,
    totalBuzz: mainBuzzAdded + blueBuzzAdded + buzzAmount,
  };
};

export function getAllowedAccountTypes(
  features: FeatureAccess,
  baseTypes: BuzzSpendType[] = []
): BuzzSpendType[] {
  const domainTypes: BuzzSpendType[] = baseTypes.filter(
    // Remove default yellow/green if provided.
    (type) => !['yellow', 'green'].includes(type)
  );

  if (features.isGreen) {
    domainTypes.push('green');
  } else {
    domainTypes.push('yellow');
  }

  return domainTypes;
}
