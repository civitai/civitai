import { VotableTagConnectorInput } from '~/server/schema/tag.schema';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import {
  ActionIcon,
  Badge,
  Group,
  HoverCard,
  useMantineTheme,
  Text,
  Divider,
  Menu,
  UnstyledButton,
} from '@mantine/core';
import { useCallback, useRef } from 'react';
import { TagType } from '@prisma/client';
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
import { NextLink } from '@mantine/next';
import { Countdown } from '~/components/Countdown/Countdown';
import { NsfwLevel } from '~/server/common/enums';
import {
  votableTagColors,
  getIsSafeBrowsingLevel,
} from '~/shared/constants/browsingLevel.constants';
import { IconDotsVertical } from '@tabler/icons-react';
import { useHiddenPreferencesContext } from '~/components/HiddenPreferences/HiddenPreferencesProvider';
import { useToggleHiddenPreferences } from '~/hooks/hidden-preferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';

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
}: VotableTagProps) {
  const currentUser = useCurrentUser();
  const clickedRef = useRef(false);
  const key = getKey({ entityType, entityId, name });
  const vote = useVotableTagStore(useCallback((state) => state.votes[key] ?? initialVote, [key])); //eslint-disable-line
  const upvoteDate = useVotableTagStore(useCallback((state) => state.upvoteDates[key], [key]));

  const theme = useMantineTheme();
  const isNsfw = !getIsSafeBrowsingLevel(nsfwLevel);
  const { color, shade } = votableTagColors[nsfwLevel][theme.colorScheme];
  const voteColor = isNsfw ? theme.colors[color][shade] : theme.colors.blue[5];
  const badgeColor = theme.fn.variant({
    color: color,
    variant: theme.colorScheme === 'dark' ? (isNsfw ? 'light' : 'filled') : 'light',
  });
  const badgeBorder = theme.fn.lighten(
    needsReview || !concrete
      ? theme.colors.yellow[8]
      : badgeColor.background ?? theme.colors.gray[4],
    0.05
  );
  const badgeBg = theme.fn.rgba(badgeColor.background ?? theme.colors.gray[4], 0.3);
  const progressBg = theme.fn.rgba(
    badgeColor.background ?? theme.colors.gray[4],
    isNsfw ? 0.4 : 0.8
  );
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
      sx={{
        position: 'relative',
        background: badgeBg,
        borderColor: badgeBorder,
        color: badgeColor.color,
        userSelect: 'none',

        [`&:before`]: {
          content: '""',
          position: 'absolute',
          top: 0,
          left: 0,
          bottom: 0,
          backgroundColor: progressBg,
          width: `${opacity * 100}%`,
        },
      }}
      pl={canVote ? 3 : 4}
      pr={!!currentUser ? 0 : undefined}
    >
      <Group spacing={0}>
        {canVote && (
          <LoginPopover>
            <UnstyledButton onClick={handleUpvote} className="z-10">
              <IconArrowBigUp
                strokeWidth={0}
                fill={
                  vote === 1
                    ? voteColor
                    : theme.colorScheme === 'dark'
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
                    : theme.colorScheme === 'dark'
                    ? 'rgba(255, 255, 255, 0.3)'
                    : 'rgba(0, 0, 0, 0.3)'
                }
                size="1rem"
              />
            </UnstyledButton>
          </LoginPopover>
        )}
        {!canVote && (
          <ActionIcon variant="transparent" size="sm" onClick={handleRemove}>
            <IconX strokeWidth={2.5} size=".75rem" />
          </ActionIcon>
        )}
        {needsReview && (
          <IconFlag
            size={12}
            strokeWidth={4}
            color={theme.colorScheme === 'dark' ? theme.colors.orange[9] : theme.colors.yellow[4]}
            style={{ marginRight: 2 }}
          />
        )}
        {!concrete && (
          <IconHourglassEmpty
            size={12}
            strokeWidth={4}
            color={theme.colorScheme === 'dark' ? theme.colors.orange[9] : theme.colors.yellow[4]}
            style={{ marginRight: 2 }}
          />
        )}
        <Text
          component={NextLink}
          href={`/images?tags=${tagId}&view=feed`}
          data-activity="tag-click:image"
          title={!isVoting ? `Score: ${score}` : undefined}
          style={{ zIndex: 10 }}
        >
          {getTagDisplayName(name)}
        </Text>
        {!!currentUser && (
          <Menu withinPortal withArrow>
            <Menu.Target>
              <ActionIcon size="sm">
                <IconDotsVertical strokeWidth={2.5} size=".75rem" />
              </ActionIcon>
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
          <Text color="yellow" weight={500}>
            Up for consideration
          </Text>
          <Text size="sm">
            {`Someone has started a vote for this tag. It must reach a score of ${constants.tagVoting.upvoteThreshold} before it will be applied to this image.`}
          </Text>
          <Text size="sm">
            <Text weight={500} component="span">
              Current Score
            </Text>
            : {score}
          </Text>
          <Divider
            label={
              <Group spacing={4}>
                <IconClock size={12} /> Voting Period Remaining
              </Group>
            }
            mt="sm"
          />
          <Text weight={500} size="sm" color="dimmed">
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
        {isHidden ? 'Unhide' : 'Hide'} images with this tag
      </Menu.Item>
    </>
  );
}
