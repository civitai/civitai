import { useUserMultipliers } from '~/components/Buzz/useBuzz';
import { getBuzzBulkMultiplier } from '~/server/utils/buzz-helpers';

export const useBuzzPurchaseCalculation = (buzzAmount: number) => {
  const { multipliers, multipliersLoading } = useUserMultipliers();
  const purchasesMultiplier = multipliers.purchasesMultiplier ?? 1;

  const calculation = getBuzzBulkMultiplier({
    buzzAmount,
    purchasesMultiplier,
  });

  return {
    isLoading: multipliersLoading,
    baseBuzz: buzzAmount,
    yellowBuzzBonus: calculation.mainBuzzAdded,
    blueBuzzBonus: calculation.blueBuzzAdded,
    totalBuzz: calculation.totalBuzz,
    hasBonus: calculation.mainBuzzAdded > 0 || calculation.blueBuzzAdded > 0,
    purchasesMultiplier,
    bulkBuzzMultiplier: calculation.bulkBuzzMultiplier,
  };
};
