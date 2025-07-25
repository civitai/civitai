import { buzzBulkBonusMultipliers } from '~/server/common/constants';

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
