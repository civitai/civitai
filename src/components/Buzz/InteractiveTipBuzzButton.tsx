import type { UnstyledButtonProps } from '@mantine/core';
import { Group, Popover, Stack, Text, UnstyledButton, Button } from '@mantine/core';
import { useInterval, useLocalStorage } from '@mantine/hooks';
import { showNotification } from '@mantine/notifications';
import { showErrorNotification } from '~/utils/notifications';
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
  const statusRef = useRef(status);
  statusRef.current = status;
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

  const { tipUserMutation, conditionalPerformTransaction, isLoadingBalance } = useBuzzTransaction({
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

  const clearConfirmTimeout = () => {
    if (confirmTimeoutRef.current) {
      clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = null;
    }
  };

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

  const sendTip = (amount: number) => {
    if (status !== 'confirming' || tipUserMutation.isPending) return;

    setShowCountDown(false);
    clearConfirmTimeout();

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

  const amountFieldRef = useRef<HTMLDivElement>(null);
  // Justin's ruling, 2026-09-17: REFUSE, never rewrite. The old code clamped an
  // out-of-range entry to the balance or the cap and sent that, so a typo could spend a
  // figure that had never been on screen. Nothing is substituted now — an amount is either
  // sendable as typed or it is refused out loud, which is why there is no confirmation
  // step, no delay and no press-ordering left to get wrong.
  const enteredAmount = (el: HTMLElement | null) => {
    // Digits only, checked BEFORE Number(). Number() accepts the whole JS numeric grammar, so
    // '5e1', '0x32', '050', '+50' and '5.0' all parse to a sendable integer while the field
    // reads as something else entirely — which is the "spends a figure never on screen" defect
    // this whole branch exists to remove. textContent also concatenates across a <br>, so a
    // pasted two-line entry would send the lines joined.
    const entered = el?.textContent?.trim() ?? '';
    if (!/^\d+$/.test(entered)) return null;
    const amount = Number(entered);
    return amount >= 1 ? amount : null;
  };

  const trySendTip = (el: HTMLElement | null) => {
    const amount = enteredAmount(el);
    // showErrorNotification, not a hand-rolled red toast: the sibling refusal on this same
    // button (buzz.utils.ts, "Not enough Buzz") uses it, so a raw showNotification would give
    // one control two different refusal chromes.
    if (amount === null) {
      showErrorNotification({
        title: 'Invalid tip amount',
        error: new Error('Enter a whole number of Buzz to tip.'),
      });
      return;
    }
    if (amount > buzzConstants.maxTipAmount) {
      showErrorNotification({
        title: 'Tip too large',
        error: new Error(
          `The most you can tip at once is ${numberWithCommas(buzzConstants.maxTipAmount)} Buzz.`
        ),
      });
      return;
    }
    // conditionalPerformTransaction returns SILENTLY while the balance query is in flight,
    // and sendTip clears the countdown before reaching it — so the press would leave the
    // pop-up open, spendable, with no timer and nothing said. Refuse here instead, before
    // anything is torn down.
    if (isLoadingBalance) {
      showErrorNotification({
        title: 'One moment',
        error: new Error('Still checking your balance. Try again in a second.'),
      });
      return;
    }
    setBuzzCounter(amount);
    // Over the user's balance needs no branch here: conditionalPerformTransaction refuses.
    // How it refuses is NOT a toast — when the user can purchase it opens the Buy Buzz modal,
    // and it shows "Not enough Buzz" only when they cannot. If the balance query is still in
    // flight it returns silently, which is the one refusal on this path the user is not told
    // about. Pre-existing; raised with Justin rather than changed here.
    sendTip(amount);
  };

  const reset = () => {
    setBuzzCounter(0);
    setShowCountDown(false);
    clearConfirmTimeout();
  };

  const startConfirming = () => {
    clearConfirmTimeout();

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
      clearConfirmTimeout();
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
                  const amount = enteredAmount(e.currentTarget);
                  if (amount !== null) setBuzzCounter(amount);
                  // Deliberately the ref, not the closed-over `status`: startConfirming
                  // re-enters the SPENDABLE state, and this path has no ledger dedup
                  // behind it. Chromium dispatches no blur when contentEditable flips
                  // false on completion, so no test covers the difference — that is why
                  // this reads correct-by-construction rather than correct-by-engine.
                  if (statusRef.current === 'confirming') startConfirming();
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                  // contentEditable would otherwise insert a newline, and a two-line amount
                  // is not a number, so it would be refused rather than sent.
                  e.preventDefault();
                  // Autorepeat: one held key must not send repeatedly. isPending catches the
                  // second send once React has re-rendered; this catches it immediately.
                  if (e.repeat) return;
                  trySendTip(e.currentTarget);
                }}
                onFocus={() => {
                  setShowCountDown(false);
                  clearConfirmTimeout();
                }}
                ref={amountFieldRef}
                className={classes.tipAmount}
                dangerouslySetInnerHTML={{ __html: buzzCounter.toString() }}
              />
            </Group>
          </Stack>
          {status !== 'pending' && (
            <LegacyActionIcon
              variant="transparent"
              color={status === 'confirmed' ? 'green' : buzzConfig.color}
              onClick={
                status === 'confirming'
                  ? () => {
                      // Read the field rather than trusting buzzCounter. Where no blur fires
                      // — touch, and engines that do not focus a button on pointer-down —
                      // buzzCounter is whatever it was before the user typed.
                      trySendTip(amountFieldRef.current);
                    }
                  : undefined
              }
              onKeyDown={(e: React.KeyboardEvent) => {
                // A held Enter on a focused button autorepeats CLICKS. isPending catches the
                // second send after a re-render; preventing the repeat stops it arriving.
                if (e.repeat && e.key === 'Enter') e.preventDefault();
              }}
              loading={tipUserMutation.isPending}
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
