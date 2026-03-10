import type { UnstyledButtonProps } from '@mantine/core';
import { Group, Popover, Stack, Text, UnstyledButton, Button } from '@mantine/core';
import { useInterval, useLocalStorage } from '@mantine/hooks';
import { showNotification } from '@mantine/notifications';
import { IconBolt, IconCheck, IconSend, IconX } from '@tabler/icons-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { useQueryBuzz } from '~/components/Buzz/useBuzz';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { LoginPopover } from '~/components/LoginPopover/LoginPopover';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { Currency } from '~/shared/utils/prisma/enums';
import { isTouchDevice } from '~/utils/device-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { useTrackEvent } from '../TrackView/track.utils';
import { useBuzzTransaction } from './buzz.utils';
import classes from './InteractiveTipBuzzButton.module.scss';
import clsx from 'clsx';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { buzzConstants, type BuzzSpendType } from '~/shared/constants/buzz.constants';
import { useBuzzCurrencyConfig } from '~/components/Currency/useCurrencyConfig';

type Props = UnstyledButtonProps &
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    toUserId: number;
    entityId: number;
    entityType: string;
    hideLoginPopover?: boolean;
  };

const CLICK_AMOUNT = 10;
const CONFIRMATION_TIMEOUT = 5000;

/**NOTES**
 Why use zustand?
 - When a user adds a reaction, we're not going to invalidate the react-query cache of parent data. This means that, if a user were to navigate to another page and then come back, the reaction data from the react-query cache would not be accurate.
 */
type BuzzTippingStore = {
  tips: Record<string, number>;
  onTip: ({
    entityType,
    entityId,
    amount,
  }: {
    entityType: string;
    entityId: number;
    amount: number;
  }) => void;
};

const getTippingKey = ({ entityType, entityId }: { entityType: string; entityId: number }) =>
  `${entityType}_${entityId}`;

const useStore = create<BuzzTippingStore>()(
  devtools(
    immer((set) => ({
      tips: {},
      onTip: ({ entityType, entityId, amount }) => {
        const key = getTippingKey({ entityType, entityId });
        set((state) => {
          if (!state.tips[key]) state.tips[key] = amount;
          else state.tips[key] += amount;
        });
      },
    }))
  )
);

export const useBuzzTippingStore = ({
  entityType,
  entityId,
}: {
  entityType: string;
  entityId: number;
}) => {
  const key = getTippingKey({ entityType, entityId });
  return useStore(useCallback((state) => state.tips[key] ?? 0, [key]));
};

const steps: [number, number][] = [
  // [20000, 2500],
  // [5000, 1000],
  // [2000, 250],
  // [1000, 100],
  // [500, 50],
  // [100, 20],
  // [50, 10],
  [0, 1],
];

export function InteractiveTipBuzzButton({
  toUserId,
  entityId,
  entityType,
  children,
  hideLoginPopover = false,
  ...buttonProps
}: Props) {
  const mobile = useContainerSmallerThan('sm');
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();

  // Get the single domain-based currency type (either green or yellow)
  const availableBuzzTypes = useAvailableBuzz([]);
  const selectedCurrencyType = availableBuzzTypes[0] as BuzzSpendType; // Use the primary domain currency

  const {
    data: { total },
  } = useQueryBuzz([selectedCurrencyType]);
  const currencyBalance = total;
  const buzzConfig = useBuzzCurrencyConfig(selectedCurrencyType);

  const [buzzCounter, setBuzzCounter] = useState(0);
  const startTimerTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const confirmTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [status, setStatus] = useState<'pending' | 'confirming' | 'confirmed'>('pending');
  const [showCountDown, setShowCountDown] = useState(false);

  const interval = useInterval(() => {
    setBuzzCounter((prevCounter) => {
      const [, step] = steps.find(([min]) => prevCounter >= min) ?? [0, 10];
      return Math.min(
        buzzConstants.maxTipAmount,
        Math.min(currencyBalance ?? 0, prevCounter + step)
      );
    });
  }, 100);

  const onTip = useStore((state) => state.onTip);
  const [dismissed, setDismissed] = useLocalStorage({
    key: `interactive-tip-buzz-tutorial`,
    defaultValue: false,
  });

  const { tipUserMutation, conditionalPerformTransaction } = useBuzzTransaction({
    message: (requiredBalance) =>
      `You don't have enough funds to send a tip. Required Buzz: ${numberWithCommas(
        requiredBalance
      )}. Buy or earn more Buzz to perform this action.`,
    performTransactionOnPurchase: false,
    accountTypes: [selectedCurrencyType],
    purchaseSuccessMessage: (purchasedBalance) => (
      <Stack>
        <Text>Thank you for your purchase!</Text>
        <Text>
          We have added <CurrencyBadge currency={Currency.BUZZ} unitAmount={purchasedBalance} /> to
          your account. You can now start tipping.
        </Text>
      </Stack>
    ),
  });
  const { trackAction } = useTrackEvent();

  const selfView = toUserId === currentUser?.id;

  const cancelTip = () => {
    if (status !== 'confirming') return;

    setStatus('pending');
    const amount = buzzCounter > 0 ? buzzCounter : CLICK_AMOUNT;
    trackAction({
      type: 'TipInteractive_Cancel',
      details: { toUserId, entityId, entityType, amount },
    }).catch(() => undefined);

    setTimeout(() => reset(), 100);
  };

  const sendTip = (amount?: number) => {
    if (status !== 'confirming') return;

    // Stop countdown
    setShowCountDown(false);
    if (confirmTimeoutRef.current) {
      clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = null;
    }

    amount ??= buzzCounter > 0 ? buzzCounter : CLICK_AMOUNT;

    const performTransaction = () => {
      trackAction({
        type: 'Tip_Confirm',
        details: { toUserId, entityType, entityId, amount },
      }).catch(() => undefined);

      return tipUserMutation.mutate(
        {
          toAccountId: toUserId,
          amount,
          entityId,
          entityType,
          fromAccountType: selectedCurrencyType,
          toAccountType: selectedCurrencyType,
          details: {
            entityId,
            entityType,
          },
        },
        {
          onSuccess: (_, { amount }) => {
            setStatus('confirmed');
            if (entityType && entityId) {
              onTip({ entityType, entityId, amount });
            }
          },
          onSettled: () => {
            setTimeout(() => {
              setStatus('pending');
              setTimeout(() => reset(), 100);
            }, 1500);
          },
        }
      );
    };

    conditionalPerformTransaction(amount, performTransaction);
  };

  const processEnteredNumber = (value: string) => {
    let amount = Number(value);
    if (isNaN(amount) || amount < 1) amount = 1;
    else if (amount > buzzConstants.maxTipAmount) amount = buzzConstants.maxTipAmount;
    else if (currencyBalance && amount > currencyBalance) amount = currencyBalance ?? 0;
    setBuzzCounter(amount);

    return amount;
  };

  const reset = () => {
    setBuzzCounter(0);
    setShowCountDown(false);
    if (confirmTimeoutRef.current) {
      clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = null;
    }
  };

  const startConfirming = () => {
    if (confirmTimeoutRef.current) {
      clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = null;
    }

    setStatus('confirming');
    setShowCountDown(true);
    confirmTimeoutRef.current = setTimeout(() => {
      setTimeout(() => reset(), 100);
      setStatus('pending');
    }, CONFIRMATION_TIMEOUT);
  };

  const clickStart = (e: React.MouseEvent | React.TouchEvent) => {
    if (isTouchDevice()) {
      e.preventDefault();
      e.stopPropagation();
      if (e.type == 'mousedown') return;
    }

    if (
      status != 'confirming' &&
      (interval.active || startTimerTimeoutRef.current || confirmTimeoutRef.current || !currentUser)
    ) {
      return;
    }

    if (confirmTimeoutRef.current) {
      setShowCountDown(false);
      clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = null;
    }

    startTimerTimeoutRef.current = setTimeout(() => {
      interval.start();
      startTimerTimeoutRef.current = null;
    }, 150);
  };

  const clickEnd = (e: React.MouseEvent | React.TouchEvent) => {
    if (isTouchDevice() && e.type == 'mouseup') return;

    if (startTimerTimeoutRef.current !== null) {
      // Was click
      setBuzzCounter((x) => Math.min(buzzConstants.maxTipAmount, x + CLICK_AMOUNT));
      clearTimeout(startTimerTimeoutRef.current);
      startTimerTimeoutRef.current = null;

      if (!dismissed) {
        showNotification({
          title: "Looks like you're onto your first tip!",
          message: (
            <Text>
              To send more than <CurrencyBadge currency={Currency.BUZZ} unitAmount={CLICK_AMOUNT} />
              , hold the button for as long as you like
            </Text>
          ),
        });
        setDismissed(true);
      }
    } else if (interval.active) {
      // Was hold
      interval.stop();
      const amount = buzzCounter > 0 ? buzzCounter : CLICK_AMOUNT;
      trackAction({
        type: 'TipInteractive_Click',
        details: { toUserId, entityId, entityType, amount },
      }).catch(() => undefined);
    } else {
      return;
    }

    startConfirming();
  };

  useEffect(() => {
    return () => interval.stop(); // when App is unmounted we should stop counter
  }, [interval]);

  if (!features.buzz) return null;

  const mouseHandlerProps = !selfView
    ? {
        onMouseDown: clickStart,
        onTouchStart: clickStart,
        onMouseUp: clickEnd,
        onMouseLeave: clickEnd,
        onTouchEnd: clickEnd,
      }
    : {};

  const buzzButton = (
    <Popover
      withArrow
      withinPortal
      radius="md"
      opened={interval.active || status !== 'pending'}
      zIndex={999}
      position="top"
      offset={mobile ? 20 : 0}
    >
      <Popover.Target>
        <UnstyledButton
          {...buttonProps}
          {...mouseHandlerProps}
          onContextMenu={(e: React.MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            return false;
          }}
          style={{
            position: 'relative',
            touchAction: 'none',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            WebkitTouchCallout: 'none',
            color: 'inherit',
            fontWeight: 'inherit',
            cursor: !selfView ? 'pointer' : 'default',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onClick={undefined}
        >
          {children}
        </UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown
        py={4}
        className={clsx({ [classes.confirming]: showCountDown })}
        style={{ '--buzz-color': buzzConfig.color } as React.CSSProperties}
      >
        <Group className={classes.popoverContent}>
          {status !== 'pending' && (
            <LegacyActionIcon variant="subtle" color="red.5" onClick={cancelTip}>
              <IconX size={20} />
            </LegacyActionIcon>
          )}
          <Stack gap={2} align="center">
            {/* Currency Balance Display */}
            <Group gap={4} mb={2}>
              <Group gap={4}>
                <CurrencyIcon currency="BUZZ" size={12} type={selectedCurrencyType} />
                <Text size="xs" c={buzzConfig.color} fw={500}>
                  {numberWithCommas(currencyBalance || 0)}
                </Text>
              </Group>
            </Group>

            <Text c={buzzConfig.color} fw={500} size="xs" opacity={0.8}>
              Tipping
            </Text>
            <Group gap={0} ml={-8}>
              <IconBolt style={{ fill: buzzConfig.color }} color={buzzConfig.color} size={20} />
              <div
                contentEditable={status === 'confirming'}
                onBlur={(e) => {
                  processEnteredNumber(e.currentTarget.textContent ?? '1');
                }}
                onKeyDown={(e) => {
                  if (e.ctrlKey && e.key === 'Enter') {
                    const amount = processEnteredNumber(e.currentTarget.textContent ?? '1');
                    sendTip(amount);
                  }
                }}
                onFocus={() => setShowCountDown(false)}
                className={classes.tipAmount}
                dangerouslySetInnerHTML={{ __html: buzzCounter.toString() }}
              />
            </Group>
          </Stack>
          {status !== 'pending' && (
            <LegacyActionIcon
              variant="transparent"
              color={status === 'confirmed' ? 'green' : buzzConfig.color}
              onClick={status === 'confirming' ? () => sendTip() : undefined}
              loading={tipUserMutation.isLoading}
            >
              {status === 'confirmed' ? <IconCheck size={20} /> : <IconSend size={20} />}
            </LegacyActionIcon>
          )}
        </Group>
      </Popover.Dropdown>
    </Popover>
  );
  if (hideLoginPopover) return buzzButton;

  return (
    <LoginPopover>
      <div style={{ display: 'flex' }}>{buzzButton}</div>
    </LoginPopover>
  );
}
