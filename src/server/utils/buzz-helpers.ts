import { buzzBulkBonusMultipliers } from '~/server/common/constants';

export const getBuzzBulkMultiplier = ({
  buzzAmount,
  purchasesMultiplier,
}: {
  buzzAmount: number;
  purchasesMultiplier: number;
}) => {
  const bulkBuzzMultiplier = buzzBulkBonusMultipliers.reduce((acc, [amount, multiplier]) => {
    if (buzzAmount >= amount) {
      return multiplier;
    }

    return acc;
  }, 1);

  const customBuzzAdded = Math.floor(buzzAmount * purchasesMultiplier - buzzAmount);
  const blueBuzzAdded = Math.max(
    Math.floor(buzzAmount * bulkBuzzMultiplier - customBuzzAdded - buzzAmount),
    0
  );

  return {
    buzzAmount,
    purchasesMultiplier,
    bulkBuzzMultiplier,
    blueBuzzAdded,
    customBuzzAdded,
    totalBlueBuzz: blueBuzzAdded,
    totalCustomBuzz: customBuzzAdded + buzzAmount,
    totalBuzz: customBuzzAdded + blueBuzzAdded + buzzAmount,
  };
};
