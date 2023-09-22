import { Button, Group, Text, GroupProps, useMantineTheme } from '@mantine/core';
import { useSessionStorage } from '@mantine/hooks';
import { ReviewReactions } from '@prisma/client';
import { IconBolt, IconMoodSmile, IconPhoto, IconPlus } from '@tabler/icons-react';
import { capitalize } from 'lodash-es';

import { LoginPopover } from '~/components/LoginPopover/LoginPopover';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { ToggleReactionInput } from '~/server/schema/reaction.schema';
import { ReactionButton, useReactionsStore } from './ReactionButton';
import {
  InteractiveTipBuzzButton,
  useBuzzTippingStore,
} from '~/components/Buzz/InteractiveTipBuzzButton';
import { abbreviateNumber } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

export type ReactionMetrics = {
  likeCount?: number;
  dislikeCount?: number;
  heartCount?: number;
  laughCount?: number;
  cryCount?: number;
  tippedAmountCount?: number;
};

type ReactionsProps = Omit<ToggleReactionInput, 'reaction'> & {
  reactions: { userId: number; reaction: ReviewReactions }[];
  metrics?: ReactionMetrics;
  readonly?: boolean;
};

const availableReactions: Partial<Record<ToggleReactionInput['entityType'], ReviewReactions[]>> = {
  image: ['Like', 'Heart', 'Laugh', 'Cry'],
};

export function PostReactions({
  metrics = {},
  imageCount,
  ...groupProps
}: {
  metrics?: ReactionMetrics;
  imageCount?: number;
} & GroupProps) {
  const total = Object.values(metrics).reduce((acc, val) => acc + (val ?? 0), 0);
  if (total === 0) return null;

  return (
    <Group spacing="xs" sx={{ cursor: 'default' }} {...groupProps}>
      {imageCount && (
        <Group spacing={4} align="center">
          <IconPhoto size={20} strokeWidth={2} />
          <Text size="sm" weight={500}>
            {imageCount}
          </Text>
        </Group>
      )}
      <Group spacing={4} align="center">
        <IconMoodSmile size={20} strokeWidth={2} />
        <Text size="sm" weight={500} pr={2}>
          {total}
        </Text>
      </Group>
    </Group>
  );
}

export function Reactions({
  reactions,
  metrics,
  entityType,
  entityId,
  readonly,
  targetUserId,
  onTipSent,
  ...groupProps
}: ReactionsProps &
  Omit<GroupProps, 'children' | 'onClick'> & {
    targetUserId?: number;
    onTipSent?: ({
      queryUtils,
      amount,
    }: {
      queryUtils: ReturnType<typeof trpc.useContext>;
      amount: number;
    }) => void;
  }) {
  const storedReactions = useReactionsStore({ entityType, entityId }) ?? {};
  const [showAll, setShowAll] = useSessionStorage<boolean>({
    key: 'showAllReactions',
    defaultValue: false,
  });

  const hasAllReactions =
    !!metrics &&
    Object.entries(metrics).every(([key, value]) => {
      // ie. converts the key `likeCount` to `Like`
      const reactionType = capitalize(key).replace(/count/, '');
      const hasReaction =
        storedReactions[reactionType] !== undefined
          ? storedReactions[reactionType]
          : !!reactions.find((x) => x.reaction === reactionType);

      return value > 0 || !!storedReactions[reactionType] || hasReaction;
    });

  const supportsBuzzTipping = ['image'].includes(entityType);

  return (
    <LoginPopover message="You must be logged in to react to this" withArrow={false}>
      <Group
        spacing={4}
        align="center"
        onClick={(e) => {
          if (!readonly) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        {...groupProps}
        noWrap
      >
        {!hasAllReactions && !readonly && (
          <Button
            variant="subtle"
            size="xs"
            color="gray"
            radius="xs"
            px={0}
            compact
            onClick={() => setShowAll((s) => !s)}
          >
            <Group spacing={2}>
              <IconPlus size={16} stroke={2.5} />
              <IconMoodSmile size={18} stroke={2.5} />
            </Group>
          </Button>
        )}

        <ReactionsList
          reactions={reactions}
          metrics={metrics}
          entityType={entityType}
          entityId={entityId}
          noEmpty={!showAll}
          readonly={readonly}
        >
          {ReactionBadge}
        </ReactionsList>
        {supportsBuzzTipping && (
          <BuzzTippingBadge
            toUserId={targetUserId}
            tippedAmountCount={metrics?.tippedAmountCount ?? 0}
            entityType={entityType}
            entityId={entityId}
            onTipSent={onTipSent}
          />
        )}
      </Group>
    </LoginPopover>
  );
}

function ReactionsList({
  reactions,
  metrics = {},
  entityType,
  entityId,
  available,
  children,
  noEmpty,
  readonly,
}: Omit<ReactionsProps, 'popoverPosition'> & {
  noEmpty?: boolean;
  available?: ReviewReactions[];
  children: (args: {
    hasReacted: boolean;
    count: number;
    reaction: ReviewReactions;
    canClick: boolean;
  }) => React.ReactElement;
  readonly?: boolean;
}) {
  const currentUser = useCurrentUser();
  const keys = Object.keys(constants.availableReactions) as ReviewReactions[];
  available ??= availableReactions[entityType];

  return (
    <>
      {keys
        .filter((reaction) => (available ? available.includes(reaction) : true))
        .map((reaction) => {
          const reactionMetricType = `${reaction.toLowerCase()}Count` as keyof ReactionMetrics;
          const count = metrics[reactionMetricType] ?? 0;
          const userReaction = reactions.find(
            (x) => x.userId === currentUser?.id && x.reaction === reaction
          );

          return (
            <ReactionButton
              key={reaction}
              reaction={reaction}
              userReaction={userReaction}
              count={count}
              entityType={entityType}
              entityId={entityId}
              readonly={!currentUser || readonly}
              noEmpty={noEmpty}
            >
              {children}
            </ReactionButton>
          );
        })}
    </>
  );
}

function ReactionBadge({
  hasReacted,
  count,
  reaction,
  canClick,
}: {
  hasReacted: boolean;
  count: number;
  reaction: ReviewReactions;
  canClick: boolean;
}) {
  const color = hasReacted ? 'blue' : 'gray';
  return (
    <Button
      size="xs"
      radius="xs"
      variant={hasReacted ? 'light' : 'subtle'}
      sx={(theme) => ({
        '&[data-disabled]': {
          cursor: 'default',
          color: theme.fn.variant({ variant: 'light', color }).color,
          background: 'transparent !important',
        },
      })}
      disabled={!canClick}
      pl={2}
      pr={3}
      color={color}
      compact
    >
      <Group spacing={4} align="center" noWrap>
        <Text sx={{ fontSize: '1.2em', lineHeight: 1.1 }}>
          {constants.availableReactions[reaction]}
        </Text>
        <Text
          sx={(theme) => ({
            color: !hasReacted && theme.colorScheme === 'dark' ? 'white' : undefined,
          })}
          inherit
        >
          {count}
        </Text>
      </Group>
    </Button>
  );
}

function BuzzTippingBadge({
  tippedAmountCount,
  entityId,
  entityType,
  toUserId,
  ...props
}: {
  tippedAmountCount: number;
  toUserId?: number;
  entityType: string;
  entityId: number;
  onTipSent?: ({
    queryUtils,
    amount,
  }: {
    queryUtils: ReturnType<typeof trpc.useContext>;
    amount: number;
  }) => void;
}) {
  const theme = useMantineTheme();
  const entityTypeCapitalized = capitalize(entityType);
  const tippedAmount = useBuzzTippingStore({ entityType: entityTypeCapitalized, entityId });
  return (
    <InteractiveTipBuzzButton
      toUserId={toUserId}
      entityType={entityTypeCapitalized}
      entityId={entityId}
      {...props}
    >
      <Button size="xs" radius="xs" variant="subtle" pl={2} pr={3} color="yellow.7" compact>
        <Group spacing={4} align="center" noWrap>
          <IconBolt color="yellow.7" style={{ fill: theme.colors.yellow[7] }} size={16} />
          <Text inherit>{abbreviateNumber(tippedAmountCount + tippedAmount)}</Text>
        </Group>
      </Button>
    </InteractiveTipBuzzButton>
  );
}

function ReactionSelector({
  reaction,
  hasReacted,
}: {
  reaction: ReviewReactions;
  hasReacted: boolean;
}) {
  return (
    <Button size="xs" radius="xs" variant={'subtle'} color={hasReacted ? 'blue' : 'gray'}>
      {constants.availableReactions[reaction]}
    </Button>
  );
}
