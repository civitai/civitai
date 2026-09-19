import type { ButtonProps, GroupProps } from '@mantine/core';
import { Badge, Button, Group, Text, Tooltip, useMantineTheme } from '@mantine/core';
import { useSessionStorage } from '@mantine/hooks';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';
import {
  IconBolt,
  IconHeart,
  IconMoodSmile,
  IconPhoto,
  IconPlus,
  IconAlertTriangle,
} from '@tabler/icons-react';
import { capitalize } from 'lodash-es';
import {
  InteractiveTipBuzzButton,
  useBuzzTippingStore,
} from '~/components/Buzz/InteractiveTipBuzzButton';

import { LoginPopover } from '~/components/LoginPopover/LoginPopover';
import { useReactionSettingsContext } from '~/components/Reaction/ReactionSettingsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
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
  /**
   * The counts in `metrics` are placeholders, not measurements — the metric read
   * produced no row for this entity. One flag rather than per-count nulls because
   * the read resolves an entity's counts together or not at all.
   */
  metricsUnknown?: boolean;
  readonly?: boolean;
};

const availableReactions: Partial<Record<ToggleReactionInput['entityType'], ReviewReactions[]>> = {
  image: ['Like', 'Heart', 'Laugh', 'Cry'],
  post: ['Like', 'Heart', 'Laugh', 'Cry'],
  bountyEntry: ['Like', 'Heart', 'Laugh', 'Cry'],
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
  metricsUnknown: metricsUnknownFromServer,
  entityType,
  entityId,
  readonly,
  targetUserId,
  className,
  showAll: initialShowAll,
  invisibleEmpty,
  disableBuzzTip,
  abbreviate,
}: ReactionsProps & {
  className?: string;
  targetUserId?: number;
  showAll?: boolean;
  invisibleEmpty?: boolean;
  disableBuzzTip?: boolean;
  abbreviate?: boolean;
}) {
  const storedReactions = useReactionsStore({ entityType, entityId });
  const [showAll, setShowAll] = useSessionStorage<boolean>({
    key: 'showAllReactions',
    defaultValue: false,
    getInitialValueInEffect: true,
  });
  const { buttonStyling, hideReactions } = useReactionSettingsContext();
  const features = useFeatureFlags();
  const metricsUnknown = !!metricsUnknownFromServer && !!features.reactionCountsUnknown;

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

  // Unknown counts have to survive the readonly early-return below, which exists to
  // drop entities nobody reacted to. Absent counts are not that.
  if (metricsUnknown) hasReactions = true;

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
            aria-label="Add reaction"
            {...(buttonStyling ? buttonStyling('AddReaction') : {})}
          >
            <IconPlus size={16} stroke={2.5} />
            <IconMoodSmile size={18} stroke={2.5} />
          </Button>
        )}

        <ReactionsList
          reactions={reactions}
          metrics={metrics}
          metricsUnknown={metricsUnknown}
          entityType={entityType}
          entityId={entityId}
          noEmpty={!(initialShowAll ?? showAll)}
          readonly={readonly}
          available={available}
          invisibleEmpty={invisibleEmpty}
          abbreviate={abbreviate}
        />
        {supportsBuzzTipping && targetUserId && (
          <BuzzTippingBadge
            toUserId={targetUserId}
            tippedAmountCount={metrics?.tippedAmountCount ?? 0}
            countUnknown={metricsUnknown}
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
  metricsUnknown,
  entityType,
  entityId,
  available = availableReactions[entityType],
  noEmpty,
  readonly,
  invisibleEmpty,
  abbreviate,
}: Omit<ReactionsProps, 'popoverPosition'> & {
  noEmpty?: boolean;
  available?: ReviewReactions[];

  readonly?: boolean;
  invisibleEmpty?: boolean;
  abbreviate?: boolean;
}) {
  const currentUser = useCurrentUser();

  // On a card (`noEmpty`) every badge would be hidden as a zero, so the row would be
  // empty and the outage invisible. One placeholder stands in for the whole list —
  // the counts are unresolved together, so there is nothing per-reaction to say.
  if (metricsUnknown && noEmpty) return <UnknownCountsBadge />;

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
              countUnknown={metricsUnknown}
              entityType={entityType}
              entityId={entityId}
              readonly={!currentUser || currentUser.muted || readonly}
              noEmpty={noEmpty}
              invisibleEmpty={invisibleEmpty}
            >
              {(props) => <ReactionBadge {...props} abbreviate={abbreviate} resetKey={entityId} />}
            </ReactionButton>
          );
        })}
    </>
  );
}

function UnknownCountsBadge() {
  return (
    <Tooltip label="We couldn't load reaction counts right now. Try again in a moment." withArrow>
      <Badge
        size="md"
        radius="xs"
        color="gray"
        variant="light"
        className="px-1 py-2"
        classNames={{ label: 'flex gap-1 items-center flex-nowrap normal-case' }}
        styles={{ root: { paddingBlock: 0 } }}
        aria-label="Reaction counts unavailable"
      >
        <IconAlertTriangle size={14} />
        <Text inherit lh={1}>
          Couldn&apos;t load
        </Text>
      </Badge>
    </Tooltip>
  );
}

function ReactionBadge({
  hasReacted,
  count,
  countUnknown,
  reaction,
  canClick,
  abbreviate,
  resetKey,
  ...buttonProps
}: {
  hasReacted: boolean;
  count: number;
  countUnknown?: boolean;
  reaction: ReviewReactions;
  canClick: boolean;
  abbreviate?: boolean;
  resetKey?: string | number;
} & Omit<ButtonProps, 'children'> &
  React.ComponentPropsWithoutRef<'button'>) {
  const color = hasReacted ? 'blue' : 'gray';
  const { hideReactionCount, buttonStyling } = useReactionSettingsContext();
  return (
    <Button
      radius="xs"
      variant={hasReacted ? 'light' : 'subtle'}
      className={clsx(classes.reactionBadge, hasReacted && classes.hasReacted)}
      disabled={!canClick}
      pl={2}
      pr={3}
      color={color}
      size="compact-xs"
      classNames={{ label: 'flex gap-1' }}
      aria-label={`${reaction} reaction`}
      {...buttonStyling?.(reaction, hasReacted)}
      {...buttonProps}
    >
      <Text style={{ fontSize: '1.2em', lineHeight: 1.1 }}>
        {constants.availableReactions[reaction]}
      </Text>{' '}
      {!hideReactionCount && (
        <Text inherit lh={1}>
          {countUnknown ? (
            '–'
          ) : (
            <AnimatedCount value={count} abbreviate={abbreviate ?? false} resetKey={resetKey} />
          )}
        </Text>
      )}
    </Button>
  );
}

function BuzzTippingBadge({
  tippedAmountCount,
  countUnknown,
  entityId,
  entityType,
  toUserId,
  readonly,
  ...props
}: {
  tippedAmountCount: number;
  countUnknown?: boolean;
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
  const buzzTipEntryType = typeToBuzzTipType[entityType as ReactionEntityType];
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
      <Text inherit lh={1}>
        {countUnknown ? (
          '–'
        ) : (
          <AnimatedCount value={tippedAmountCount + tippedAmount} resetKey={entityId} />
        )}
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
