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
  // Tracks whether the current confirm flow was opened by a real user gesture
  // (a click or hold that started + ended on the button). Used to gate the
  // TipInteractive_* analytics events so they don't fire on stray pointer
  // events (e.g. onMouseLeave while scrolling a feed).
  const gestureCommittedRef = useRef(false);
  // Tracks whether the primary pointer is currently held down as part of a
  // press that *originated on this button*. clickReenter consults this so it
  // only re-arms a press that genuinely started here — a press begun elsewhere
  // and dragged across the button has pressActiveRef.current === false and is
  // ignored, keeping the round-1 phantom-event fix intact. Set in clickStart;
  // cleared by a global pointerup/pointercancel so a release anywhere (even
  // off the button, which fires no mouseup here) ends the press.
  const pressActiveRef = useRef(false);
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
    // Only emit a Cancel for a confirm flow that was actually opened by a real
    // user gesture. This stops phantom Cancel events from pointer/lifecycle
    // churn that never represented a deliberate tip attempt.
    if (gestureCommittedRef.current) {
      trackAction({
        type: 'TipInteractive_Cancel',
        details: { toUserId, entityId, entityType, amount },
      }).catch(() => undefined);
    }

    // reset() clears gestureCommittedRef — see reset()'s doc comment.
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
      // The confirm flow resolved with a real tip. The gesture flag is cleared
      // by reset() in onSettled below once the mutation settles.
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

    // conditionalPerformTransaction returns false on every branch where the
    // transaction did NOT proceed: balance still loading, insufficient funds
    // with no purchasable account, or the buy-buzz modal being opened. On those
    // branches performTransaction is never called, so tipUserMutation.onSettled
    // -> reset() never runs and gestureCommittedRef would otherwise leak `true`
    // into the next confirm flow. Reset here so the gesture genuinely
    // terminates and the popover returns to its idle state.
    const transactionStarted = conditionalPerformTransaction(amount, performTransaction);
    if (!transactionStarted) {
      setStatus('pending');
      reset();
    }
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
    // Clears the gesture-committed flag. reset() is invoked by every tip-flow
    // termination path: cancel, successful confirm (mutation onSettled),
    // auto-dismiss timeout, phantom mouseleave abort, and — via the explicit
    // check in sendTip — the conditionalPerformTransaction early-returns
    // (balance loading, insufficient funds, buy-buzz modal). Those
    // early-returns do NOT route through here on their own, which is why
    // sendTip must call reset() when conditionalPerformTransaction returns
    // false; otherwise the flag would leak `true` into the next confirm flow.
    gestureCommittedRef.current = false;
  };

  const startConfirming = () => {
    if (confirmTimeoutRef.current) {
      clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = null;
    }

    setStatus('confirming');
    setShowCountDown(true);
    confirmTimeoutRef.current = setTimeout(() => {
      // Auto-dismiss after inactivity. This is a timeout, not a deliberate
      // user cancel, so no TipInteractive_Cancel is emitted. reset() clears
      // the gesture flag.
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

    // A press has genuinely begun on this button (mousedown/touchstart cleared
    // the guards above). Record it so clickReenter can tell a continued press
    // apart from an unrelated press dragged over the button.
    pressActiveRef.current = true;
    startTimerTimeoutRef.current = setTimeout(() => {
      interval.start();
      startTimerTimeoutRef.current = null;
    }, 150);
  };

  // Re-arm a press when the pointer drags back onto the button.
  //
  // A quick tap whose pointer wobbles off the (small) button before the 150ms
  // hold timer fires is treated by clickEnd's mouseleave branch as a phantom
  // press and aborted. Without this handler, dragging the still-held pointer
  // back onto the button does nothing (mousedown already fired and won't fire
  // again), so the tip would be silently dropped.
  //
  // We only re-arm when the primary mouse button is still held (e.buttons === 1)
  // AND that press originated on this button (pressActiveRef). A bare hover with
  // no button pressed — e.g. the cursor passing over the button while scrolling
  // a feed — has e.buttons === 0 and is ignored; a press that began elsewhere
  // and was dragged onto the button has pressActiveRef === false and is also
  // ignored. Together these keep the round-1 phantom-event fix intact. Mouse
  // only: touch has no equivalent enter event and is intentionally left
  // unchanged.
  const clickReenter = (e: React.MouseEvent) => {
    if (isTouchDevice()) return;
    // Primary button not held — a stray hover, not a continued press.
    if (e.buttons !== 1) return;
    // A button is down, but e.buttons === 1 alone does not prove this button
    // started the press. Without this check a press begun elsewhere and
    // dragged over the tip button would re-arm and emit a phantom tip.
    if (!pressActiveRef.current) return;
    // Already mid-press or mid-confirm — nothing to re-arm.
    if (
      interval.active ||
      startTimerTimeoutRef.current ||
      confirmTimeoutRef.current ||
      status !== 'pending' ||
      !currentUser
    ) {
      return;
    }

    startTimerTimeoutRef.current = setTimeout(() => {
      interval.start();
      startTimerTimeoutRef.current = null;
    }, 150);
  };

  const clickEnd = (e: React.MouseEvent | React.TouchEvent) => {
    if (isTouchDevice() && e.type == 'mouseup') return;

    // onMouseLeave is wired to clickEnd so an in-progress press is handled when
    // the pointer drags off the button. We must distinguish two cases:
    //
    //  - PHANTOM press: the pointer left before the 150ms hold timer fired, so
    //    the press never committed (startTimerTimeoutRef is still pending). This
    //    is a stray pointer event from scrolling a feed, not a tip gesture —
    //    abort it. Completing here is what produced phantom TipInteractive_Click
    //    events (and the Cancel/timeout churn that follows).
    //
    //  - COMMITTED hold: the press was held past the 150ms timer (the interval
    //    is active and has been incrementing buzzCounter). That is a genuine,
    //    intentional hold — if the cursor then drifts off the small button
    //    before release, the user still meant to tip. Fall through to complete
    //    the gesture (emit TipInteractive_Click, open the confirm popover) as
    //    the pre-PR onMouseLeave did, so a real hold-and-drift is not dropped.
    if (e.type === 'mouseleave' && startTimerTimeoutRef.current !== null) {
      // Phantom press — not yet committed. Abort: clear the hold timer and
      // reset state so the stranded buzzCounter doesn't pollute the next tip.
      clearTimeout(startTimerTimeoutRef.current);
      startTimerTimeoutRef.current = null;
      if (interval.active) interval.stop();
      reset();
      return;
    }

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

    // A genuine tap or hold-and-release on the button that opens the tip
    // confirm UI. Mark the confirm flow as user-initiated so a later cancel
    // is recorded as a real TipInteractive_Cancel.
    gestureCommittedRef.current = true;

    startConfirming();
  };

  useEffect(() => {
    return () => interval.stop(); // when App is unmounted we should stop counter
  }, [interval]);

  useEffect(() => {
    // A pointer release anywhere ends the current press. Clearing the flag
    // globally (rather than in this component's own handlers) is what makes the
    // pressActiveRef origin check sound: a press released off the button fires
    // no mouseup on this element, so without this listener the flag would stay
    // stale-true and clickReenter could re-arm a later, unrelated press.
    const clearPress = () => {
      pressActiveRef.current = false;
    };
    window.addEventListener('pointerup', clearPress);
    window.addEventListener('pointercancel', clearPress);
    return () => {
      window.removeEventListener('pointerup', clearPress);
      window.removeEventListener('pointercancel', clearPress);
    };
  }, []);

  if (!features.buzz) return null;

  const mouseHandlerProps = !selfView
    ? {
        onMouseDown: clickStart,
        onTouchStart: clickStart,
        onMouseUp: clickEnd,
        onMouseLeave: clickEnd,
        onMouseEnter: clickReenter,
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
