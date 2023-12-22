import {
  ActionIcon,
  createStyles,
  Group,
  keyframes,
  Popover,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
  UnstyledButtonProps,
  useMantineTheme,
} from '@mantine/core';
import { LoginPopover } from '~/components/LoginPopover/LoginPopover';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useCallback, useEffect, useRef, useState } from 'react';
import { IconBolt, IconCheck, IconSend, IconX } from '@tabler/icons-react';
import { useInterval, useLocalStorage } from '@mantine/hooks';
import { showConfirmNotification } from '~/utils/notifications';
import { v4 as uuidv4 } from 'uuid';
import { hideNotification, showNotification } from '@mantine/notifications';
import { TransactionType } from '~/server/schema/buzz.schema';
import { devtools } from 'zustand/middleware';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { Currency } from '@prisma/client';
import { useBuzzTransaction } from './buzz.utils';
import { useTrackEvent } from '../TrackView/track.utils';
import { isTouchDevice } from '~/utils/device-helpers';
import { useBuzz } from '~/components/Buzz/useBuzz';
import { useContainerSmallerThan } from '~/components/ContainerProvider/useContainerSmallerThan';
import { constants } from '~/server/common/constants';

type Props = UnstyledButtonProps & {
  toUserId: number;
  entityId: number;
  entityType: string;
  hideLoginPopover?: boolean;
};

const CONFIRMATION_THRESHOLD = 100;
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
  const { theme, classes, cx } = useStyle();
  const mobile = useContainerSmallerThan('sm');
  const currentUser = useCurrentUser();
  const { balance } = useBuzz();
  const features = useFeatureFlags();

  const [buzzCounter, setBuzzCounter] = useState(0);
  const startTimerTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const confirmTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [status, setStatus] = useState<'pending' | 'confirming' | 'confirmed'>('pending');
  const [showCountDown, setShowCountDown] = useState(false);

  const interval = useInterval(() => {
    setBuzzCounter((prevCounter) => {
      const [, step] = steps.find(([min]) => prevCounter >= min) ?? [0, 10];
      return Math.min(constants.buzz.maxEntityTip, Math.min(balance ?? 0, prevCounter + step));
    });
  }, 100);

  const onTip = useStore((state) => state.onTip);
  const [dismissed, setDismissed] = useLocalStorage({
    key: `interactive-tip-buzz-tutorial`,
    defaultValue: false,
  });

  const { tipUserMutation } = useBuzzTransaction();
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

    setStatus('confirmed');

    // Stop countdown
    setShowCountDown(false);
    if (confirmTimeoutRef.current) {
      clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = null;
    }

    amount ??= buzzCounter > 0 ? buzzCounter : CLICK_AMOUNT;
    tipUserMutation.mutate(
      {
        toAccountId: toUserId,
        amount,
        entityId,
        entityType,
        details: {
          entityId,
          entityType,
        },
      },
      {
        onSuccess: (_, { amount }) => {
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

  const processEnteredNumber = (value: string) => {
    let amount = Number(value);
    if (isNaN(amount) || amount < 1) amount = 1;
    else if (amount > constants.buzz.maxEntityTip) amount = constants.buzz.maxEntityTip;
    else if (balance && amount > balance) amount = balance ?? 0;
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

  const stopCountdown = () => {
    if (confirmTimeoutRef.current) {
      clearTimeout(confirmTimeoutRef.current);
      confirmTimeoutRef.current = null;
    }
    setShowCountDown(false);
  };

  const clickStart = (e: any) => {
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

  const clickEnd = (e: any) => {
    if (isTouchDevice() && e.type == 'mouseup') return;

    if (startTimerTimeoutRef.current !== null) {
      // Was click
      setBuzzCounter((x) => Math.min(constants.buzz.maxEntityTip, x + CLICK_AMOUNT));
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
  }, []);

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
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            return false;
          }}
          sx={{
            position: 'relative',
            touchAction: 'none',
            userSelect: 'none',
            WebkitUserSelect: 'none',
            WebkitTouchCallout: 'none',
            color: 'inherit',
            fontWeight: 'inherit',
          }}
          style={{
            cursor: !selfView ? 'pointer' : 'default',
          }}
          onClick={undefined}
        >
          {children}
        </UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown py={4} className={cx({ [classes.confirming]: showCountDown })}>
        <Group className={classes.popoverContent}>
          {status !== 'pending' && (
            <ActionIcon color="red.5" onClick={cancelTip}>
              <IconX size={20} />
            </ActionIcon>
          )}
          <Stack spacing={2} align="center">
            <Text color="yellow.7" weight={500} size="xs" opacity={0.8}>
              Tipping
            </Text>
            <Group spacing={0} ml={-8}>
              <IconBolt style={{ fill: theme.colors.yellow[7] }} color="yellow.7" size={20} />
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
                onFocus={stopCountdown}
                className={classes.tipAmount}
                dangerouslySetInnerHTML={{ __html: buzzCounter.toString() }}
              ></div>
            </Group>
          </Stack>
          {status !== 'pending' && (
            <ActionIcon
              variant="transparent"
              color={status === 'confirmed' ? 'green' : 'yellow.5'}
              onClick={() => sendTip()}
              loading={tipUserMutation.isLoading}
            >
              {status === 'confirmed' ? <IconCheck size={20} /> : <IconSend size={20} />}
            </ActionIcon>
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

const useStyle = createStyles((theme) => ({
  popoverContent: {
    position: 'relative',
    zIndex: 3,
  },
  confirming: {
    [`&:before`]: {
      content: '""',
      position: 'absolute',
      zIndex: 2,
      top: 0,
      left: 0,
      height: '100%',
      width: 0,
      // backgroundColor: theme.colors.gray[1],
      backgroundColor: theme.colors.red[6],
      opacity: 0,
      animation: `${fillEffect} ${CONFIRMATION_TIMEOUT}ms linear forwards`,
    },
  },
  tipAmount: {
    fontVariantNumeric: 'tabular-nums',
    fontWeight: 500,
    color: theme.colors.yellow[7],
    fontSize: 16,
    padding: 0,
    lineHeight: 1,
    outline: 0,
    display: 'inline-block',
  },
}));

const fillEffect = keyframes({
  to: {
    width: '100%',
    opacity: 0.3,
    // backgroundColor: 'red',
  },
});
