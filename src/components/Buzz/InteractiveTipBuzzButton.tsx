import {
  Group,
  Popover,
  Stack,
  Text,
  UnstyledButton,
  UnstyledButtonProps,
  useMantineTheme,
} from '@mantine/core';
import { LoginPopover } from '~/components/LoginPopover/LoginPopover';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useCallback, useEffect, useRef, useState } from 'react';
import { IconBolt } from '@tabler/icons-react';
import { useInterval, useLocalStorage } from '@mantine/hooks';
import { showConfirmNotification } from '~/utils/notifications';
import { v4 as uuidv4 } from 'uuid';
import { hideNotification, showNotification } from '@mantine/notifications';
import { trpc } from '~/utils/trpc';
import { TransactionType } from '~/server/schema/buzz.schema';
import { devtools } from 'zustand/middleware';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { Currency } from '@prisma/client';
import { useBuzzTransaction } from './buzz.utils';
import { useTrackEvent } from '../TrackView/track.utils';

type Props = UnstyledButtonProps & {
  toUserId?: number;
  entityId?: number;
  entityType?: string;
  onTipSent?: ({
    queryUtils,
    amount,
  }: {
    queryUtils: ReturnType<typeof trpc.useContext>;
    amount: number;
  }) => void;
};

const CONFIRMATION_THRESHOLD = 100;

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
  [20000, 2500],
  [5000, 1000],
  [2000, 250],
  [1000, 100],
  [500, 50],
  [100, 20],
  [50, 10],
  [0, 1],
];

export function InteractiveTipBuzzButton({
  toUserId,
  entityId,
  entityType,
  children,
  onTipSent,
  ...buttonProps
}: Props) {
  const theme = useMantineTheme();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();

  const [buzzCounter, setBuzzCounter] = useState(0);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const interval = useInterval(() => {
    setBuzzCounter((prevCounter) => {
      const [, step] = steps.find(([min]) => prevCounter >= min) ?? [0, 10];
      return Math.min(currentUser?.balance ?? 0, prevCounter + step);
    });
  }, 150);

  const onTip = useStore((state) => state.onTip);
  const [dismissed, setDismissed] = useLocalStorage({
    key: `interactive-tip-buzz-tutorial`,
    defaultValue: false,
  });

  const { createBuzzTransactionMutation } = useBuzzTransaction();
  const { trackAction } = useTrackEvent();

  const onSendTip = async (tipAmount: number) => {
    createBuzzTransactionMutation.mutate(
      {
        toAccountId: toUserId,
        type: TransactionType.Tip,
        amount: Number(tipAmount),
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
      }
    );
  };

  const reset = () => {
    setBuzzCounter(0);
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  const startCounter = () => {
    if (interval.active || timeoutRef.current) {
      return;
    }
    interval.start();
  };

  const stopCounter = () => {
    const isClick = buzzCounter === 0;

    if (interval.active) {
      interval.stop();
      const amount = buzzCounter > 0 ? buzzCounter : 10;
      const requiresConfirmation = amount >= CONFIRMATION_THRESHOLD;

      if (!dismissed && isClick) {
        showNotification({
          title: "Looks like you're onto your first tip!",
          message: (
            <Text>
              To send more than <CurrencyBadge currency={Currency.BUZZ} unitAmount={10} />, hold the
              button for as long as you like
            </Text>
          ),
        });
      }

      setDismissed(true);

      if (amount && !timeoutRef.current) {
        const uuid = uuidv4();
        trackAction({
          type: 'TipInteractive_Click',
          details: { toUserId, entityId, entityType, amount },
        }).catch(() => undefined);

        showConfirmNotification({
          id: uuid,
          color: 'yellow.7',
          title: 'Please confirm your tip:',
          message: (
            <Stack spacing={'xs'}>
              <Group spacing={4}>
                <Text>
                  You are about to tip{' '}
                  <CurrencyBadge currency={Currency.BUZZ} unitAmount={amount} />
                </Text>
              </Group>
              <Text> Are you sure?</Text>
              {!requiresConfirmation && (
                <Text color="red">
                  This action will be confirmed automatically if you do nothing.
                </Text>
              )}
            </Stack>
          ),
          onConfirm: requiresConfirmation
            ? () => {
                onSendTip(amount);
                hideNotification(uuid);
                reset();
              }
            : undefined,
          onCancel: () => {
            trackAction({
              type: 'TipInteractive_Cancel',
              details: { toUserId, entityId, entityType, amount },
            }).catch(() => undefined);
            hideNotification(uuid);
            reset();
          },
        });

        if (!requiresConfirmation) {
          timeoutRef.current = setTimeout(() => {
            hideNotification(uuid);
            onSendTip(amount);
            reset();
          }, 8000);
        }
      }
    }
  };

  useEffect(() => {
    return () => interval.stop(); // when App is unmounted we should stop counter
  }, []);

  if (!features.buzz) return null;
  if (toUserId === currentUser?.id) return null;

  return (
    <LoginPopover>
      <UnstyledButton
        onMouseDown={startCounter}
        onMouseUp={stopCounter}
        onMouseLeave={stopCounter}
        onTouchStart={startCounter}
        onTouchEnd={stopCounter}
        style={{ position: 'relative', touchAction: 'none' }}
        {...buttonProps}
        onClick={undefined}
      >
        <Popover withArrow withinPortal radius="md" opened={interval.active} zIndex={999}>
          <Popover.Target>
            <div>{children}</div>
          </Popover.Target>
          <Popover.Dropdown>
            <Group spacing={0}>
              <Text color="yellow.7" weight={500}>
                Tipping
              </Text>
              <IconBolt style={{ fill: theme.colors.yellow[7] }} color="yellow.7" />
              <Text color="yellow.7" weight={500} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {buzzCounter}
              </Text>
            </Group>
          </Popover.Dropdown>
        </Popover>
      </UnstyledButton>
    </LoginPopover>
  );
}
