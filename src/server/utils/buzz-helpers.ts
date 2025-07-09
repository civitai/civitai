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

  const yellowBuzzAdded = Math.floor(buzzAmount * purchasesMultiplier - buzzAmount);
  const blueBuzzAdded = Math.max(
    Math.floor(buzzAmount * bulkBuzzMultiplier - yellowBuzzAdded - buzzAmount),
    0
  );

  return {
    buzzAmount,
    purchasesMultiplier,
    bulkBuzzMultiplier,
    blueBuzzAdded,
    yellowBuzzAdded,
    totalBlueBuzz: blueBuzzAdded,
    totalYellowBuzz: yellowBuzzAdded + buzzAmount,
    totalBuzz: yellowBuzzAdded + blueBuzzAdded + buzzAmount,
  };
};
