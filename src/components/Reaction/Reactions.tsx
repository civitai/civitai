import type { GroupProps } from '@mantine/core';
import { Badge, Button, Group, Text, useMantineTheme } from '@mantine/core';
import { useSessionStorage } from '@mantine/hooks';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';
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
import type { ReactionEntityType, ToggleReactionInput } from '~/server/schema/reaction.schema';
import { abbreviateNumber } from '~/utils/number-helpers';
import { AnimatedCount } from '~/components/Metrics';
import { ReactionButton, useReactionsStore } from './ReactionButton';
import React from 'react';
import clsx from 'clsx';
import classes from './Reactions.module.css';

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
  post: ['Like', 'Heart', 'Laugh', 'Cry'],
  bountyEntry: ['Like', 'Heart', 'Laugh', 'Cry'],
  clubPost: ['Like', 'Heart', 'Laugh', 'Cry'],
  commentOld: ['Like', 'Heart', 'Laugh', 'Cry'],
  comment: ['Like', 'Heart', 'Laugh', 'Cry'],
  article: ['Like', 'Heart', 'Laugh', 'Cry'],
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
    <Group gap="xs" style={{ cursor: 'default' }} {...groupProps}>
      {imageCount && (
        <Group gap={4} align="center">
          <IconPhoto size={20} strokeWidth={2} />
          <Text size="sm" fw={500}>
            {imageCount}
          </Text>
        </Group>
      )}
      {total > 0 && (
        <Group gap={4} align="center">
          <IconHeart size={20} strokeWidth={2} />
          <Text size="sm" fw={500} pr={2}>
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
  showAll: initialShowAll,
  invisibleEmpty,
  disableBuzzTip,
}: ReactionsProps & {
  className?: string;
  targetUserId?: number;
  showAll?: boolean;
  invisibleEmpty?: boolean;
  disableBuzzTip?: boolean;
}) {
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

  const supportsBuzzTipping = !disableBuzzTip && ['image'].includes(entityType);

  if (readonly && !hasReactions) return null;
  if (hideReactions) return null;

  return (
    <LoginPopover message="You must be logged in to react to this">
      <div
        className={clsx('flex items-center justify-center gap-1', className)}
        onClick={(e) => {
          if (!readonly) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
      >
        {!initialShowAll && !hasAllReactions && !readonly && (
          <Button
            variant="subtle"
            color="gray"
            radius="xs"
            px={0}
            size="compact-xs"
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
          noEmpty={!(initialShowAll ?? showAll)}
          readonly={readonly}
          available={available}
          invisibleEmpty={invisibleEmpty}
        />
        {supportsBuzzTipping && targetUserId && (
          <BuzzTippingBadge
            toUserId={targetUserId}
            tippedAmountCount={metrics?.tippedAmountCount ?? 0}
            entityType={entityType}
            entityId={entityId}
            hideLoginPopover
            readonly={readonly}
          />
        )}
      </div>
    </LoginPopover>
  );
}

const keys = Object.keys(constants.availableReactions) as ReviewReactions[];
const keyMap = keys.reduce<Record<string, keyof ReactionMetrics>>(
  (acc, key) => ({ ...acc, [key]: `${key.toLowerCase()}Count` as keyof ReactionMetrics }),
  {}
);

function getReactionCount(key: ReviewReactions, metrics: ReactionMetrics) {
  const reactionMetricType = keyMap[key];
  return metrics[reactionMetricType] ?? 0;
}

function ReactionsList({
  reactions,
  metrics = {},
  entityType,
  entityId,
  available = availableReactions[entityType],
  noEmpty,
  readonly,
  invisibleEmpty,
}: Omit<ReactionsProps, 'popoverPosition'> & {
  noEmpty?: boolean;
  available?: ReviewReactions[];

  readonly?: boolean;
  invisibleEmpty?: boolean;
}) {
  const currentUser = useCurrentUser();
  return (
    <>
      {keys
        .filter((reaction) => (available ? available.includes(reaction) : true))
        .sort((a, b) => {
          if (!invisibleEmpty || !noEmpty) return 0;
          const countA = getReactionCount(a, metrics);
          const countB = getReactionCount(b, metrics);
          if (countA === 0 && countB > 0) return 1;
          else if (countB === 0 && countA > 0) return -1;
          return 0;
        })
        .map((reaction) => {
          const count = getReactionCount(reaction, metrics);
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
              invisibleEmpty={invisibleEmpty}
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
      radius="xs"
      variant={hasReacted ? 'light' : 'subtle'}
      className={classes.reactionBadge}
      disabled={!canClick}
      pl={2}
      pr={3}
      color={color}
      size="compact-xs"
      classNames={{ label: 'flex gap-1' }}
      {...buttonStyling?.(reaction, hasReacted)}
    >
      <Text style={{ fontSize: '1.2em', lineHeight: 1.1 }}>
        {constants.availableReactions[reaction]}
      </Text>{' '}
      {!hideReactionCount && <AnimatedCount value={count} abbreviate={false} />}
    </Button>
  );
}

function BuzzTippingBadge({
  tippedAmountCount,
  entityId,
  entityType,
  toUserId,
  readonly,
  ...props
}: {
  tippedAmountCount: number;
  toUserId: number;
  entityType: string;
  entityId: number;
  hideLoginPopover?: boolean;
  readonly?: boolean;
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

  const badge = (
    <Badge
      size="md"
      radius="xs"
      color="yellow.7"
      variant="light"
      {...(buttonStyling ? buttonStyling('BuzzTip') : {})}
      className="cursor-pointer px-1 py-2 hover:bg-yellow-5/20"
      classNames={{ label: 'flex gap-0.5 items-center flex-nowrap' }}
      styles={{ root: { paddingBlock: 0 } }}
    >
      <IconBolt color="yellow.7" style={{ fill: theme.colors.yellow[7] }} size={16} />
      <Text inherit>
        <AnimatedCount value={tippedAmountCount + tippedAmount} />
      </Text>
    </Badge>
  );

  return readonly ? (
    badge
  ) : (
    <InteractiveTipBuzzButton
      toUserId={toUserId}
      entityType={buzzTipEntryType}
      entityId={entityId}
      {...props}
    >
      {badge}
    </InteractiveTipBuzzButton>
  );
}
