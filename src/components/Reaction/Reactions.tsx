import { Badge, Button, Group, GroupProps, Text, useMantineTheme } from '@mantine/core';
import { useSessionStorage } from '@mantine/hooks';
import { ReviewReactions } from '~/shared/utils/prisma/enums';
import { IconBolt, IconHeart, IconMoodSmile, IconPhoto, IconPlus } from '@tabler/icons-react';
import { capitalize } from 'lodash-es';
import {
  InteractiveTipBuzzButton,
  useBuzzTippingStore,
} from '~/components/Buzz/InteractiveTipBuzzButton';

import { LoginPopover } from '~/components/LoginPopover/LoginPopover';
import { useReactionSettingsContext } from '~/components/Reaction/ReactionSettingsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { constants } from '~/server/common/constants';
import { ReactionEntityType, ToggleReactionInput } from '~/server/schema/reaction.schema';
import { abbreviateNumber } from '~/utils/number-helpers';
import { ReactionButton, useReactionsStore } from './ReactionButton';
import React from 'react';
import clsx from 'clsx';

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
  bountyEntry: ['Like', 'Heart', 'Laugh', 'Cry'],
  clubPost: ['Like', 'Heart', 'Laugh', 'Cry'],
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
  if (total === 0 && imageCount === 0) return null;

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
      {total > 0 && (
        <Group spacing={4} align="center">
          <IconHeart size={20} strokeWidth={2} />
          <Text size="sm" weight={500} pr={2}>
            {total}
          </Text>
        </Group>
      )}
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
  className,
}: ReactionsProps & { className?: string; targetUserId?: number }) {
  const storedReactions = useReactionsStore({ entityType, entityId });
  const [showAll, setShowAll] = useSessionStorage<boolean>({
    key: 'showAllReactions',
    defaultValue: false,
    getInitialValueInEffect: true,
  });
  const { buttonStyling, hideReactions } = useReactionSettingsContext();

  const ignoredKeys = ['tippedAmountCount'];
  const available = availableReactions[entityType];
  let hasReactions = false;
  let hasAllReactions = true;
  if (metrics) {
    for (const [key, value] of Object.entries(metrics)) {
      // ie. converts the key `likeCount` to `Like`
      const reactionType = capitalize(key).replace(/count/, '');
      if (available && !available.includes(reactionType as ReviewReactions)) {
        continue;
      }
      if (ignoredKeys.includes(key)) {
        continue;
      }

      const hasReaction =
        storedReactions[reactionType] !== undefined
          ? storedReactions[reactionType]
          : !!reactions.find((x) => x.reaction === reactionType);

      if (value > 0 || !!storedReactions[reactionType] || hasReaction) {
        hasReactions = true;
      } else {
        hasAllReactions = false;
      }
    }
  } else hasAllReactions = false;

  const supportsBuzzTipping = ['image'].includes(entityType);

  if (readonly && !hasReactions) return null;
  if (hideReactions) return null;

  return (
    <LoginPopover message="You must be logged in to react to this" withArrow={false}>
      <div
        className={clsx('flex items-center justify-center gap-1', className)}
        onClick={(e) => {
          if (!readonly) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
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
            classNames={{ inner: 'flex gap-0.5' }}
            {...(buttonStyling ? buttonStyling('AddReaction') : {})}
          >
            <IconPlus size={16} stroke={2.5} />
            <IconMoodSmile size={18} stroke={2.5} />
          </Button>
        )}

        <ReactionsList
          reactions={reactions}
          metrics={metrics}
          entityType={entityType}
          entityId={entityId}
          noEmpty={!showAll}
          readonly={readonly}
          available={available}
        />
        {supportsBuzzTipping && targetUserId && !readonly && (
          <BuzzTippingBadge
            toUserId={targetUserId}
            tippedAmountCount={metrics?.tippedAmountCount ?? 0}
            entityType={entityType}
            entityId={entityId}
            hideLoginPopover
          />
        )}
      </div>
    </LoginPopover>
  );
}

const keys = Object.keys(constants.availableReactions) as ReviewReactions[];
function ReactionsList({
  reactions,
  metrics = {},
  entityType,
  entityId,
  available = availableReactions[entityType],
  noEmpty,
  readonly,
}: Omit<ReactionsProps, 'popoverPosition'> & {
  noEmpty?: boolean;
  available?: ReviewReactions[];

  readonly?: boolean;
}) {
  const currentUser = useCurrentUser();

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
              readonly={!currentUser || currentUser.muted || readonly}
              noEmpty={noEmpty}
            >
              {ReactionBadge}
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
  const { hideReactionCount, buttonStyling } = useReactionSettingsContext();
  return (
    <Button
      size="xs"
      radius="xs"
      variant={hasReacted ? 'light' : 'subtle'}
      sx={(theme) => ({
        '&[data-disabled]': {
          cursor: 'default',
          color: theme.fn.variant({ variant: 'light', color }).color,
          ...(!hasReacted && { background: 'transparent !important' }),
          // TODO: there is a little pop-in here as it changes from grey to lightblue due to being disabled
        },
        '&:hover': {
          background: theme.fn.rgba(theme.fn.variant({ variant: 'light', color }).background!, 0.4),
        },
      })}
      disabled={!canClick}
      pl={2}
      pr={3}
      color={color}
      compact
      classNames={{ label: 'flex gap-1' }}
      {...(buttonStyling ? buttonStyling(reaction, hasReacted) : {})}
    >
      <Text sx={{ fontSize: '1.2em', lineHeight: 1.1 }}>
        {constants.availableReactions[reaction]}
      </Text>
      {!hideReactionCount && <Text inherit>{count}</Text>}
      {/* {constants.availableReactions[reaction]} {!hideReactionCount && count} */}
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
  toUserId: number;
  entityType: string;
  entityId: number;
  hideLoginPopover?: boolean;
}) {
  const { buttonStyling } = useReactionSettingsContext();
  const theme = useMantineTheme();
  const typeToBuzzTipType: Partial<Record<ReactionEntityType, string>> = {
    image: 'Image',
  };
  const buzzTipEntryType = typeToBuzzTipType[entityType];
  const tippedAmount = useBuzzTippingStore({ entityType: buzzTipEntryType ?? 'Image', entityId });

  if (!buzzTipEntryType) {
    return null;
  }

  return (
    <InteractiveTipBuzzButton
      toUserId={toUserId}
      entityType={buzzTipEntryType}
      entityId={entityId}
      {...props}
    >
      <Badge
        size="md"
        radius="xs"
        py={10}
        px={3}
        color="yellow.7"
        variant="light"
        {...(buttonStyling ? buttonStyling('BuzzTip') : {})}
        classNames={{ inner: 'flex gap-0.5 items-center' }}
      >
        <IconBolt color="yellow.7" style={{ fill: theme.colors.yellow[7] }} size={16} />
        <Text inherit>{abbreviateNumber(tippedAmountCount + tippedAmount)}</Text>
      </Badge>
    </InteractiveTipBuzzButton>
  );
}
