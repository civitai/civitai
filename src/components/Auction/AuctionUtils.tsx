import { ActionIcon, ActionIconProps, Stack, Text, Tooltip } from '@mantine/core';
import { showNotification, updateNotification } from '@mantine/notifications';
import { IconCheck, IconGavel, IconX } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import React, { useMemo, useState } from 'react';
import { useAuctionContext } from '~/components/Auction/AuctionProvider';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import type { ResourceSelectOptions } from '~/components/ImageGeneration/GenerationForm/resource-select.types';
import { useSignalConnection, useSignalTopic } from '~/components/Signals/SignalsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { SignalMessages, SignalTopic } from '~/server/common/enums';
import type { GetAuctionBySlugReturn } from '~/server/services/auction.service';
import {
  getBaseModelResourceTypes,
  getBaseModelSetType,
} from '~/shared/constants/generation.constants';
import { AuctionType, Currency, ModelType } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

type ResourceOptions = Exclude<ResourceSelectOptions['resources'], undefined>;

export const getModelTypesForAuction = (ab: GetAuctionBySlugReturn['auctionBase'] | undefined) => {
  if (!ab) return [] as ResourceOptions;

  if (ab.ecosystem === null) {
    return [
      {
        type: ModelType.Checkpoint,
      },
    ] as ResourceOptions;
  }

  //  as BaseModelResourceTypes[keyof BaseModelResourceTypes]
  return (getBaseModelResourceTypes(ab.ecosystem) ?? []).filter(
    (t) => t.type !== 'Checkpoint'
  ) as ResourceOptions;
};

export function usePurchaseBid() {
  const queryUtils = trpc.useUtils();
  const [createLoading, setCreateLoading] = useState(false);
  const { setJustBid } = useAuctionContext();

  const { conditionalPerformTransaction } = useBuzzTransaction({
    message: (requiredBalance: number) =>
      `You don't have enough funds to perform this action. Required Buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more Buzz to perform this action.`,
    purchaseSuccessMessage: (purchasedBalance) => (
      <Stack>
        <Text>Thank you for your purchase!</Text>
        <Text>
          We have added <CurrencyBadge currency={Currency.BUZZ} unitAmount={purchasedBalance} /> to
          your account and entered your bid.
        </Text>
      </Stack>
    ),
    performTransactionOnPurchase: true,
  });

  const { mutate: createBidMutate } = trpc.auction.createBid.useMutation({
    onMutate({ auctionId, entityId }) {
      setCreateLoading(true);
      const notificationId = `submit-bid-${auctionId}-${entityId}`;

      showNotification({
        id: notificationId,
        loading: true,
        autoClose: false,
        title: 'Submitting bid...',
        message: '',
      });
    },
    onSuccess: async (res, { auctionId, entityId }) => {
      setJustBid({ auctionId, entityId });

      const notificationId = `submit-bid-${auctionId}-${entityId}`;

      updateNotification({
        id: notificationId,
        icon: <IconCheck size={18} />,
        color: 'teal',
        title: 'Created bid successfully!',
        message: '',
        autoClose: 3000,
        disallowClose: false,
      });

      // TODO updates instead for MyBids
      await queryUtils.auction.getBySlug.invalidate({ slug: res.slug });
      await queryUtils.auction.getMyBids.invalidate();
      await queryUtils.auction.getMyRecurringBids.invalidate();
      await queryUtils.model.getRecentlyBid.invalidate();
      // TODO possibly update getAll for the minprice
    },
    onError(error, { auctionId, entityId }) {
      const notificationId = `submit-bid-${auctionId}-${entityId}`;

      updateNotification({
        id: notificationId,
        icon: <IconX size={18} />,
        color: 'red',
        title: 'Failed to create bid',
        message: error.message,
      });
    },
    onSettled() {
      setCreateLoading(false);
    },
  });

  const handleBuy = ({
    bidPrice,
    auctionId,
    modelId,
    isRecurring,
    recurUntil,
    onSuccess,
  }: {
    bidPrice?: number;
    auctionId?: number;
    modelId?: number;
    isRecurring?: boolean;
    recurUntil?: Date | 'forever';
    onSuccess?: () => void;
  }) => {
    // TODO handle not logged in

    if (createLoading) return;
    if (!bidPrice || bidPrice < 0) {
      return showErrorNotification({
        error: new Error('No valid bid price set'),
      });
    }
    if (!modelId) {
      return showErrorNotification({
        error: new Error('No valid model selected'),
      });
    }
    if (!auctionId) {
      return showErrorNotification({
        error: new Error('No valid auction selected'),
      });
    }

    const performTransaction = () => {
      createBidMutate(
        {
          entityId: modelId,
          amount: bidPrice,
          auctionId: auctionId,
          recurringUntil: isRecurring && recurUntil ? recurUntil : undefined,
        },
        { onSuccess }
      );
    };
    conditionalPerformTransaction(bidPrice, performTransaction);
  };

  return { handleBuy, createLoading };
}

export const BidModelButton = ({
  entityData,
  ...actionIconProps
}: ActionIconProps & {
  entityData: Exclude<GetAuctionBySlugReturn['bids'][number]['entityData'], undefined>;
}) => {
  const { setSelectedModel } = useAuctionContext();
  const router = useRouter();
  const features = useFeatureFlags();

  const { data: auctions = [] } = trpc.auction.getAll.useQuery(undefined, {
    enabled: features.auctions,
  });

  const destAuction = useMemo(() => {
    const modelSet =
      entityData.model.type === ModelType.Checkpoint
        ? null
        : getBaseModelSetType(entityData.baseModel);
    return auctions.find(
      (a) => a.auctionBase.type === AuctionType.Model && a.auctionBase.ecosystem === modelSet
    );
  }, [auctions, entityData.baseModel, entityData.model.type]);

  const handle = () => {
    if (!destAuction) return;

    setSelectedModel({
      ...entityData,
      strength: -1,
      minStrength: -1,
      maxStrength: -1,
      trainedWords: [],
      canGenerate: true,
      hasAccess: true,
      covered: true,
    });

    router.push(`/auctions/${destAuction.auctionBase.slug}`).catch();
  };

  if (!features.auctions) return <></>;
  if (entityData.model.cannotPromote) return <></>;

  return (
    <Tooltip
      label={destAuction ? 'Bid to feature this model' : 'No auction available for this model'}
    >
      <div>
        <ActionIcon
          onClick={handle}
          disabled={!destAuction}
          size="xl"
          variant="light"
          {...actionIconProps}
        >
          <IconGavel size={30} />
        </ActionIcon>
      </div>
    </Tooltip>
  );
};

export const useAuctionTopicListener = (auctionId?: number) => {
  const utils = trpc.useUtils();
  const currentUser = useCurrentUser();

  // TODO
  useSignalConnection(SignalMessages.AuctionUpdate, (data: any) => {
    console.log('auction update', data);
  });
  useSignalConnection(SignalMessages.AuctionBidChange, (data: any) => {
    console.log('auction bid change', data);
  });
  useSignalConnection(SignalMessages.TopicUpdate, (data: { topic: string; count: number }) => {
    // if topic === .... then get count
    console.log('auction count', data);
  });

  // TODO is there a race condition? missing the first topic message
  useSignalTopic(auctionId ? `${SignalTopic.Auction}:${auctionId}` : undefined, true);
};
