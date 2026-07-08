import dayjs from '~/shared/utils/dayjs';

export const calculateClubTierNextBillingDate = ({
  membership,
  upgradeTier,
}: {
  membership: {
    nextBillingAt: Date;
    clubTier: {
      unitAmount: number;
    };
  };
  upgradeTier: {
    unitAmount: number;
  };
}) => {
  const nextBillingDate = dayjs(membership.nextBillingAt);
  const now = dayjs();
  const remainingDays = nextBillingDate.diff(now, 'day');
  // Note: Use the current clubTier unitAmount to calculate the current day price. Although the user might be paying less,
  // we want to calculate the remaining days based on the current clubTier price.
  const currentDayPrice = membership.clubTier.unitAmount / 30;
  const remainingPrice = remainingDays * currentDayPrice;
  const daysOnNewTier = Math.ceil((remainingPrice * 30) / upgradeTier.unitAmount);
  const nextBillingDateOnNewTier = nextBillingDate.add(daysOnNewTier, 'day');

  return {
    addedDaysFromCurrentTier: daysOnNewTier,
    nextBillingDate: nextBillingDateOnNewTier,
  };
};
