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
// A press this soon after a clamp rewrote the amount did not follow from SEEING it. Covers
// every gesture that supplies its own confirmation — a held Enter in the field, a held Enter
// on the focused send button (which autorepeats clicks), a double-click — with one rule
// instead of one per input device. The exact number is a judgement, not a measurement.
const CLAMP_CONFIRM_DELAY = 500;

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

  const sendTip = (amount?: number) => {
    if (status !== 'confirming' || tipUserMutation.isPending) return;

    setShowCountDown(false);
    clearConfirmTimeout();

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

  const amountFieldRef = useRef<HTMLDivElement>(null);
  // -Infinity, not 0: performance.now() is milliseconds since navigation start, so a 0
  // sentinel reads as "clamped at page load" and refuses every send for the first
  // CLAMP_CONFIRM_DELAY of a document's life.
  const clampShownAtRef = useRef(-Infinity);

  // Ordering is a COUNTER, not a clock. performance.now() is clamped to 1ms in Firefox and
  // Safari and 100us in Chromium without cross-origin isolation, and pointerdown and the
  // blur it causes land in one event-loop turn — so the two stamps tie, `a < a` is false,
  // and the guard reports "did not predate" for a press that did. A tie is a silent send of
  // the whole balance, so the comparison must not be able to tie.
  const eventSeqRef = useRef(0);
  const clampSeqRef = useRef(0);
  const pressSeqRef = useRef(0);
  const markPressStart = () => {
    pressSeqRef.current = ++eventSeqRef.current;
  };

  const clampIsTooFreshToConfirm = () =>
    performance.now() - clampShownAtRef.current < CLAMP_CONFIRM_DELAY;

  // Ordering, which a duration cannot express. The press that confirms a clamp has to have
  // BEGUN after it: pressing the icon is what blurs the field and causes the clamp, so the
  // elapsed time at click is the length of the user's own hold. Hold the button past
  // CLAMP_CONFIRM_DELAY and one uninterrupted press would otherwise confirm the figure it
  // just rewrote — which on this path is the whole balance.
  const pressPredatesClamp = () => pressSeqRef.current < clampSeqRef.current;

  // Shared by blur and Enter. The comparison is on the STRING, not on Number(): a numeric
  // comparison passes '5e3' and '0x32' untouched, which sends an amount the field does not
  // read as. After a rewrite the field holds exactly amount.toString(), so this converges.
  const applyEnteredAmount = (el: HTMLElement | null) => {
    // No node means nothing is on screen to have been authorised. Refuse rather than fall
    // back to a default and spend it.
    if (!el) return { amount: 0, clamped: true };
    const entered = el.textContent ?? '';
    const amount = processEnteredNumber(entered);
    const clamped = entered.trim() !== amount.toString();
    // Written directly because buzzCounter may already equal the clamp, and then no
    // re-render repaints dangerouslySetInnerHTML — the field would keep showing the
    // rejected entry and never become sendable.
    if (clamped) {
      el.textContent = amount.toString();
      clampShownAtRef.current = performance.now();
      clampSeqRef.current = ++eventSeqRef.current;
    }
    return { amount, clamped };
  };

  const reset = () => {
    setBuzzCounter(0);
    setShowCountDown(false);
    clampShownAtRef.current = -Infinity;
    clampSeqRef.current = 0;
    pressSeqRef.current = 0;
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
                  applyEnteredAmount(e.currentTarget);
                  // Deliberately the ref, not the closed-over `status`: startConfirming
                  // re-enters the SPENDABLE state, and this path has no ledger dedup
                  // behind it. Chromium dispatches no blur when contentEditable flips
                  // false on completion, so no test covers the difference — that is why
                  // this reads correct-by-construction rather than correct-by-engine.
                  if (statusRef.current === 'confirming') startConfirming();
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                  // contentEditable would otherwise insert a newline, and Number() of a
                  // two-line amount is NaN, which processEnteredNumber floors to 1 Buzz.
                  e.preventDefault();
                  // Autorepeat would otherwise supply the confirming press itself, from a
                  // key the user never released — and that press IS the safeguard.
                  if (e.repeat) return;
                  const { amount, clamped } = applyEnteredAmount(e.currentTarget);
                  // `clamped` is implied by the freshness check on BOTH send paths —
                  // applyEnteredAmount stamps as it rewrites, microseconds earlier — so no
                  // test can tell the two apart. The one case where it is not implied is the
                  // null-element return, which refuses WITHOUT stamping. Kept as the
                  // statement of intent, and because it stops being implied if that moves.
                  if (clamped || clampIsTooFreshToConfirm()) return;
                  sendTip(amount);
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
                      // Read the field rather than trusting buzzCounter. Where no blur
                      // fires — touch, and engines that do not focus a button on
                      // pointer-down — buzzCounter is whatever it was before the user
                      // typed, and sendTip() would spend that instead of what is shown.
                      // Where a blur DOES fire it has just clamped, and the freshness
                      // check is what refuses that press.
                      const { amount, clamped } = applyEnteredAmount(amountFieldRef.current);
                      if (clamped || clampIsTooFreshToConfirm() || pressPredatesClamp()) return;
                      sendTip(amount);
                    }
                  : undefined
              }
              // A held Enter on this button autorepeats CLICKS, and once the hold passes
              // CLAMP_CONFIRM_DELAY those clicks look like a deliberate confirmation. The
              // freshness rule bounds how soon a confirmation can arrive; only this bounds
              // one arriving from a key that was never released.
              onPointerDown={markPressStart}
              onKeyDown={(e: React.KeyboardEvent) => {
                if (e.key !== 'Enter') return;
                // Autorepeat must not activate the button: a held Enter fires repeated
                // clicks, and once the hold passes CLAMP_CONFIRM_DELAY they look deliberate.
                if (e.repeat) {
                  e.preventDefault();
                  return;
                }
                // Keyboard and assistive-tech activation dispatch a click with NO pointer
                // event. Without this the press ordering never advances, so after any clamp
                // the icon is permanently dead for anyone without a pointer.
                markPressStart();
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
