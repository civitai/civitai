import { Group, Paper, Stack, Text, Tooltip } from '@mantine/core';
import { showNotification, updateNotification } from '@mantine/notifications';
import NumberFlow from '@number-flow/react';
import { IconCheck, IconUsers, IconX } from '@tabler/icons-react';
import React, { useState } from 'react';
import { useAuctionContext } from '~/components/Auction/AuctionProvider';
import { useBuzzTransaction } from '~/components/Buzz/buzz.utils';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import {
  useSignalConnection,
  useSignalContext,
  useSignalTopic,
} from '~/components/Signals/SignalsProvider';
import { SignalMessages, SignalTopic } from '~/server/common/enums';
import type { GetAuctionBySlugReturn } from '~/server/services/auction.service';
import { Currency } from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';
import { numberWithCommas } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

export function usePurchaseBid() {
  const queryUtils = trpc.useUtils();
  const [createLoading, setCreateLoading] = useState(false);
  const { setJustBid } = useAuctionContext();
  const { connected, registeredTopics } = useSignalContext();

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
        withCloseButton: true,
      });

      if (!connected || !registeredTopics.includes(`${SignalTopic.Auction}:${auctionId}`)) {
        await queryUtils.auction.getBySlug.invalidate({ slug: res.slug });
      }
      // TODO updates instead for MyBids
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

export const AuctionViews = () => {
  const { viewing, selectedAuction } = useAuctionContext();

  const views = selectedAuction?.id ? viewing[selectedAuction.id] ?? 0 : 0;
  if (!views) return <></>;

  return (
    <Tooltip label="Currently viewing">
      <Paper radius="sm" shadow="xs" px={8} py={4} withBorder className="bg-gray-0 dark:bg-dark-6">
        <Group gap={4} className="min-w-[55px] cursor-default justify-center">
          <IconUsers size={14} />
          <NumberFlow
            format={{ notation: 'compact' }}
            respectMotionPreference={false}
            value={views}
            className="text-sm"
          />
          {/*<button*/}
          {/*  onClick={() => {*/}
          {/*    const delta = Math.floor(Math.random() * 100000);*/}
          {/*    if (selectedAuction)*/}
          {/*      setViewing((prev) => ({ ...prev, [selectedAuction?.id]: delta }));*/}
          {/*  }}*/}
          {/*>*/}
          {/*  change*/}
          {/*</button>*/}
        </Group>
      </Paper>
    </Tooltip>
  );
};

export const useAuctionTopicListener = (auctionId?: number) => {
  const queryUtils = trpc.useUtils();
  const { setViewing } = useAuctionContext();

  // console.log('listening to auction', auctionId);

  useSignalConnection(SignalMessages.AuctionBidChange, (data: GetAuctionBySlugReturn) => {
    // console.log('auction bid change', data);
    queryUtils.auction.getBySlug.setData({ slug: data.auctionBase.slug }, data);
  });
  useSignalConnection(SignalMessages.TopicUpdate, (data: { topic: string; count: number }) => {
    // console.log('auction count', data);
    setViewing((prev) => {
      const auctionId = parseInt(data.topic.split(':')[1]);
      if (isNaN(auctionId)) return prev;

      return {
        ...prev,
        [auctionId]: Math.max(0, data.count),
      };
    });
  });

  // TODO is there a race condition? missing the first topic message
  useSignalTopic(auctionId ? `${SignalTopic.Auction}:${auctionId}` : undefined, true);
};
