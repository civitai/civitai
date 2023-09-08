import { Currency } from '@prisma/client';
import { useMemo } from 'react';

import { GetInfiniteBountySchema } from '~/server/schema/bounty.schema';
import { trpc } from '~/utils/trpc';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { removeEmpty } from '~/utils/object-helpers';
import { MIN_CREATE_BOUNTY_AMOUNT } from '~/server/common/constants';

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
  user?: { id: number } | null
) => {
  if (!bounty || !user) {
    return false;
  }

  return (
    !!bounty.benefactors.find((b) => b.user.id === bounty.user?.id) && bounty.user?.id === user?.id
  );
};

export const isBenefactor = (
  bounty?: {
    id: number;
    user: { id: number } | null;
    benefactors: { currency: Currency; user: { id: number } }[];
  },
  user?: { id: number } | null
) => {
  if (!bounty || !user) {
    return false;
  }

  return !!bounty.benefactors.find((b) => b.user.id === bounty.user?.id);
};

export const useBountyFilters = () => {
  const storeFilters = useFiltersContext((state) => state.bounties);
  return removeEmpty(storeFilters);
};

export const useQueryBounties = (
  filters: Partial<GetInfiniteBountySchema>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const { data, ...rest } = trpc.bounty.getInfinite.useInfiniteQuery(filters, {
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    ...options,
  });

  const bounties = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data?.pages]);

  return { data, bounties, ...rest };
};

export const getMainBountyAmount = (bounty?: {
  id: number;
  user: { id: number } | null;
  benefactors: { currency: Currency; user: { id: number }; unitAmount: number }[];
}) => {
  if (!bounty) {
    return 0;
  }

  const mainBenefactor = bounty.benefactors.find((b) => isMainBenefactor(bounty, b.user));

  if (mainBenefactor) {
    return mainBenefactor.unitAmount;
  }

  return MIN_CREATE_BOUNTY_AMOUNT;
};
