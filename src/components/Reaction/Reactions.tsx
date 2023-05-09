import { Button, Group, Text, GroupProps } from '@mantine/core';
import { useSessionStorage } from '@mantine/hooks';
import { ReviewReactions } from '@prisma/client';
import { IconMoodSmile, IconPhoto, IconPlus } from '@tabler/icons';
import { capitalize } from 'lodash-es';

import { LoginPopover } from '~/components/LoginPopover/LoginPopover';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { ToggleReactionInput } from '~/server/schema/reaction.schema';
import { ReactionButton, useReactionsStore } from './ReactionButton';

export type ReactionMetrics = {
  likeCount?: number;
  dislikeCount?: number;
  heartCount?: number;
  laughCount?: number;
  cryCount?: number;
};

type ReactionsProps = Omit<ToggleReactionInput, 'reaction'> & {
  reactions: { userId: number; reaction: ReviewReactions }[];
  metrics?: ReactionMetrics;
  readonly?: boolean;
  withinPortal?: boolean;
};

export function PostReactions({
  metrics = {},
  imageCount,
  ...groupProps
}: {
  metrics?: ReactionMetrics;
  imageCount?: number;
} & GroupProps) {
  const total = Object.values(metrics).reduce((a, b) => a + b, 0);
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
  withinPortal,
  ...groupProps
}: ReactionsProps & Omit<GroupProps, 'children' | 'onClick'>) {
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
      variant="light"
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
      <Group spacing={4} align="center">
        <Text sx={{ fontSize: '1.2em', lineHeight: 1.1 }}>
          {constants.availableReactions[reaction]}
        </Text>
        <Text inherit>{count}</Text>
      </Group>
    </Button>
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
