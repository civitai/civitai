import { Currency } from '@prisma/client';
import { useMemo } from 'react';

export const getBountyCurrency = (bounty?: {
  id: number;
  user: { id: number } | null;
  benefactors: { currency: Currency; user: { id: number } }[];
}) => {
  if (!bounty || !bounty.user) {
    return Currency.BUZZ;
  }

  const mainBenefactor = bounty.benefactors.find(
    (benefactor) => benefactor.user.id === bounty.user?.id
  );

  if (mainBenefactor) {
    return mainBenefactor.currency;
  }

  // Default currency for bounties will be buzz.
  return Currency.BUZZ;
};

export const isMainBenefactor = (
  bounty?: {
    id: number;
    user: { id: number } | null;
    benefactors: { currency: Currency; user: { id: number } }[];
  },
  user?: { id: number }
) => {
  if (!bounty || !user) {
    return false;
  }

  return (
    !!bounty.benefactors.find((b) => b.user.id === bounty.user?.id) && bounty.user?.id === user?.id
  );
};
