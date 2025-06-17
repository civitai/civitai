import type { VotableTagConnectorInput } from '~/server/schema/tag.schema';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import {
  Badge,
  Group,
  HoverCard,
  useMantineTheme,
  Text,
  Divider,
  Menu,
  UnstyledButton,
  useComputedColorScheme,
  lighten,
  alpha,
} from '@mantine/core';
import { useCallback, useRef } from 'react';
import type { TagType } from '~/shared/utils/prisma/enums';
import {
  IconArrowBigDown,
  IconArrowBigUp,
  IconClock,
  IconFlag,
  IconHourglassEmpty,
  IconX,
} from '@tabler/icons-react';
import { LoginPopover } from '~/components/LoginPopover/LoginPopover';
import { getTagDisplayName } from '~/libs/tags';
import { constants } from '~/server/common/constants';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { Countdown } from '~/components/Countdown/Countdown';
import type { NsfwLevel } from '~/server/common/enums';
import {
  votableTagColors,
  getIsSafeBrowsingLevel,
} from '~/shared/constants/browsingLevel.constants';
import { IconDotsVertical } from '@tabler/icons-react';
import { useHiddenPreferencesContext } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import { useToggleHiddenPreferences } from '~/hooks/hidden-preferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import classes from './VotableTag.module.scss';

type VotableTagProps = VotableTagConnectorInput & {
  tagId: number;
  initialVote?: number;
  type: TagType;
  nsfwLevel: NsfwLevel;
  name: string;
  score: number;
  needsReview?: boolean;
  concrete?: boolean;
  lastUpvote?: Date | null;
  onChange: (changed: { name: string; vote: number }) => void;
  highlightContested?: boolean;
};

type VotableTagStore = {
  votes: Record<string, number>;
  upvoteDates: Record<string, Date>;
  setVote: (
    vote: VotableTagConnectorInput & {
      name: string;
      vote: number;
    }
  ) => void;
};

const getKey = ({ entityType, entityId, name }: VotableTagConnectorInput & { name: string }) =>
  `${entityType}_${entityId}_${name}`;

export const useVotableTagStore = create<VotableTagStore>()(
  immer((set) => ({
    votes: {},
    upvoteDates: {},
    setVote: ({ entityType, entityId, name, vote }) => {
      const key = getKey({ entityType, entityId, name });
      set((state) => {
        state.votes[key] = vote;
        if (vote > 0) state.upvoteDates[key] = new Date();
        else delete state.upvoteDates[key];
      });
    },
  }))
);

export function VotableTag({
  entityType,
  entityId,
  tagId,
  initialVote = 0,
  nsfwLevel = 1,
  name,
  score,
  needsReview = false,
  concrete = false,
  lastUpvote,
  onChange,
  highlightContested,
}: VotableTagProps) {
  const currentUser = useCurrentUser();
  const clickedRef = useRef(false);
  const key = getKey({ entityType, entityId, name });
  const vote = useVotableTagStore(useCallback((state) => state.votes[key] ?? initialVote, [key])); //eslint-disable-line
  const upvoteDate = useVotableTagStore(useCallback((state) => state.upvoteDates[key], [key]));
  const moderatorVariant = highlightContested && needsReview;

  const theme = useMantineTheme();
  const colorScheme = useComputedColorScheme('dark', { getInitialValueInEffect: false });
  const isNsfw = !getIsSafeBrowsingLevel(nsfwLevel);
  const { color, shade } = votableTagColors[nsfwLevel][colorScheme];
  const voteColor = isNsfw ? theme.colors[color][shade] : theme.colors.blue[5];
  const badgeColor = theme.variantColorResolver({
    color: moderatorVariant ? 'grape' : color,
    variant: colorScheme === 'dark' ? (isNsfw ? 'light' : 'filled') : 'light',
    theme,
  });
  const badgeBorder = lighten(
    needsReview || !concrete
      ? theme.colors.yellow[8]
      : badgeColor.background ?? theme.colors.gray[4],
    0.05
  );
  const badgeBg = alpha(badgeColor.background ?? theme.colors.gray[4], 0.3);
  const progressBg = alpha(badgeColor.background ?? theme.colors.gray[4], isNsfw ? 1 : 0.8);
  const opacity = 0.2 + (Math.max(Math.min(score, 10), 0) / 10) * 0.8;

  if (upvoteDate) lastUpvote = upvoteDate;
  const votingEnds =
    !concrete && lastUpvote
      ? new Date(lastUpvote.getTime() + constants.tagVoting.voteDuration)
      : undefined;
  const isVoting = !!votingEnds && votingEnds > new Date();

  const runDebouncer = (fn: () => void) => {
    if (!clickedRef.current) {
      clickedRef.current = true;
      fn();
      debounce(() => (clickedRef.current = false), 500);
    }
  };

  const handleUpvote: React.MouseEventHandler = (e) => {
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();

    runDebouncer(() => {
      const value = vote !== 1 ? 1 : 0;
      onChange({ name, vote: value });
    });
  };

  const handleDownvote: React.MouseEventHandler = (e) => {
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();

    runDebouncer(() => {
      const value = vote !== -1 ? -1 : 0;
      onChange({ name, vote: value });
    });
  };

  const handleRemove: React.MouseEventHandler = (e) => {
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();

    runDebouncer(() => {
      onChange({ name, vote: 0 });
    });
  };

  const canVote = tagId;
  let badge = (
    <Badge
      radius="sm"
      key={tagId}
      style={{
        '--badge-border-color': badgeBorder,
        '--badge-bg': badgeBg,
        '--badge-color': badgeColor.color,
        '--progress-bg': progressBg,
        '--progress-width': `${opacity * 100}%`,
        borderWidth: moderatorVariant ? 3 : 1,
      }}
      className={classes.mainBadge}
      pl={canVote ? 3 : 4}
      pr={!!currentUser ? 0 : undefined}
    >
      <Group gap={0} wrap="nowrap">
        {canVote && (
          <LoginPopover>
            <UnstyledButton onClick={handleUpvote} className="z-10">
              <IconArrowBigUp
                strokeWidth={0}
                fill={
                  vote === 1
                    ? voteColor
                    : colorScheme === 'dark'
                    ? 'rgba(255, 255, 255, 0.3)'
                    : 'rgba(0, 0, 0, 0.3)'
                }
                size="1rem"
              />
            </UnstyledButton>
          </LoginPopover>
        )}
        {canVote && (
          <LoginPopover>
            <UnstyledButton onClick={handleDownvote} className="z-10 mr-1">
              <IconArrowBigDown
                strokeWidth={0}
                fill={
                  vote === -1
                    ? voteColor
                    : colorScheme === 'dark'
                    ? 'rgba(255, 255, 255, 0.3)'
                    : 'rgba(0, 0, 0, 0.3)'
                }
                size="1rem"
              />
            </UnstyledButton>
          </LoginPopover>
        )}
        {!canVote && (
          <LegacyActionIcon variant="transparent" size="sm" onClick={handleRemove}>
            <IconX strokeWidth={2.5} size=".75rem" />
          </LegacyActionIcon>
        )}
        {needsReview && (
          <IconFlag size={12} strokeWidth={4} className="mr-0.5 text-yellow-4 dark:text-orange-9" />
        )}
        {!concrete && (
          <IconHourglassEmpty
            size={12}
            strokeWidth={4}
            className="mr-0.5 text-yellow-4 dark:text-orange-9"
          />
        )}
        <Text
          component={Link}
          href={`/images?tags=${tagId}&view=feed`}
          data-activity="tag-click:image"
          title={!isVoting ? `Score: ${score}` : undefined}
          style={{ zIndex: 10 }}
          inherit
        >
          {getTagDisplayName(name)}
        </Text>
        {!!currentUser && (
          <Menu withinPortal withArrow>
            <Menu.Target>
              <LegacyActionIcon size="sm">
                <IconDotsVertical strokeWidth={2.5} size=".75rem" />
              </LegacyActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <TagContexDropdown tagId={tagId} name={name} />
            </Menu.Dropdown>
          </Menu>
        )}
      </Group>
    </Badge>
  );

  if (isVoting) {
    badge = (
      <HoverCard withArrow width={300} shadow="md" openDelay={500}>
        <HoverCard.Target>{badge}</HoverCard.Target>
        <HoverCard.Dropdown>
          <Text c="yellow" fw={500}>
            Up for consideration
          </Text>
          <Text size="sm">
            {`Someone has started a vote for this tag. It must reach a score of ${constants.tagVoting.upvoteThreshold} before it will be applied to this image.`}
          </Text>
          <Text size="sm">
            <Text fw={500} component="span">
              Current Score
            </Text>
            : {score}
          </Text>
          <Divider
            label={
              <Group gap={4}>
                <IconClock size={12} /> Voting Period Remaining
              </Group>
            }
            mt="sm"
          />
          <Text fw={500} size="sm" c="dimmed">
            <Countdown endTime={votingEnds} />
          </Text>
        </HoverCard.Dropdown>
      </HoverCard>
    );
  }

  return badge;
}

let timer: NodeJS.Timeout | undefined;
const debounce = (func: () => void, timeout = 1000) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    func();
  }, timeout);
};

function TagContexDropdown({ tagId, name }: { tagId: number; name: string }) {
  const { hiddenTags } = useHiddenPreferencesContext();
  const { mutate } = useToggleHiddenPreferences();
  const isHidden = hiddenTags.get(tagId);

  return (
    <>
      <Menu.Item onClick={() => mutate({ kind: 'tag', data: [{ id: tagId, name }] })}>
        {isHidden ? 'Unhide' : 'Hide'} content with this tag
      </Menu.Item>
    </>
  );
}
