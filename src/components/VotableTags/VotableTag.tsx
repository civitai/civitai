import { VotableTagConnectorInput } from '~/server/schema/tag.schema';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { ActionIcon, Badge, Group, useMantineTheme } from '@mantine/core';
import { useCallback, useRef } from 'react';
import { TagType, NsfwLevel } from '@prisma/client';
import { IconArrowBigDown, IconArrowBigUp, IconFlag, IconX } from '@tabler/icons-react';
import { LoginPopover } from '~/components/LoginPopover/LoginPopover';
import { getTagDisplayName } from '~/libs/tags';
import Link from 'next/link';
import { nsfwLevelUI } from '~/libs/moderation';

type VotableTagProps = VotableTagConnectorInput & {
  tagId: number;
  initialVote?: number;
  type: TagType;
  nsfw: NsfwLevel;
  name: string;
  score: number;
  needsReview?: boolean;
  onChange: (changed: { name: string; vote: number }) => void;
};

type VotableTagStore = {
  votes: Record<string, number>;
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
    setVote: ({ entityType, entityId, name, vote }) => {
      const key = getKey({ entityType, entityId, name });
      set((state) => {
        state.votes[key] = vote;
      });
    },
  }))
);

export function VotableTag({
  entityType,
  entityId,
  tagId,
  initialVote = 0,
  type,
  nsfw,
  name,
  score,
  needsReview = false,
  onChange,
}: VotableTagProps) {
  const clickedRef = useRef(false);
  const key = getKey({ entityType, entityId, name });
  const vote = useVotableTagStore(useCallback((state) => state.votes[key], [key])) ?? initialVote;
  const setVote = useVotableTagStore((state) => state.setVote);

  const theme = useMantineTheme();
  const isModeration = type === 'Moderation';
  const nsfwUI = isModeration ? nsfwLevelUI[nsfw] : undefined;
  const voteColor = nsfwUI ? theme.colors[nsfwUI.color][nsfwUI.shade] : theme.colors.blue[5];
  const badgeColor = theme.fn.variant({
    color: nsfwUI?.color ?? 'gray',
    variant: !!nsfwUI ? 'light' : 'filled',
  });
  const badgeBorder = theme.fn.lighten(
    needsReview ? theme.colors.yellow[8] : badgeColor.background ?? theme.colors.gray[4],
    0.05
  );
  const badgeBg = theme.fn.rgba(badgeColor.background ?? theme.colors.gray[4], 0.3);
  const progressBg = theme.fn.rgba(
    badgeColor.background ?? theme.colors.gray[4],
    isModeration ? 0.4 : 0.8
  );
  const opacity = 0.2 + (Math.max(Math.min(score, 10), 0) / 10) * 0.8;

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
      setVote({ entityId, entityType, name, vote: value });
      onChange({ name, vote: value });
    });
  };

  const handleDownvote: React.MouseEventHandler = (e) => {
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();

    runDebouncer(() => {
      const value = vote !== -1 ? -1 : 0;
      setVote({ entityId, entityType, name, vote: value });
      onChange({ name, vote: value });
    });
  };

  const handleRemove: React.MouseEventHandler = (e) => {
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();

    runDebouncer(() => {
      setVote({ entityId, entityType, name, vote: 0 });
      onChange({ name, vote: 0 });
    });
  };

  const canVote = tagId;
  return (
    <Link href={`/images?tags=${tagId}&view=feed`} passHref>
      <Badge
        component="a"
        radius="xs"
        key={tagId}
        sx={{
          position: 'relative',
          background: badgeBg,
          borderColor: badgeBorder,
          color: badgeColor.color,
          cursor: 'pointer',
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
        pl={canVote ? 0 : 4}
        pr={0}
      >
        <Group spacing={0}>
          {canVote && (
            <LoginPopover>
              <ActionIcon
                variant="transparent"
                size="sm"
                onClick={handleUpvote}
                color={vote === 1 ? voteColor : undefined}
              >
                <IconArrowBigUp
                  strokeWidth={0}
                  fill={vote === 1 ? voteColor : 'rgba(255, 255, 255, 0.3)'}
                  size="1rem"
                />
              </ActionIcon>
            </LoginPopover>
          )}
          {needsReview && (
            <IconFlag
              size={12}
              strokeWidth={4}
              color={theme.colors.yellow[4]}
              style={{ marginRight: 2 }}
            />
          )}
          <span title={`Score: ${score}`} style={{ zIndex: 10 }}>
            {getTagDisplayName(name)}
          </span>
          {canVote && (
            <LoginPopover>
              <ActionIcon variant="transparent" size="sm" onClick={handleDownvote}>
                <IconArrowBigDown
                  strokeWidth={0}
                  fill={vote === -1 ? voteColor : 'rgba(255, 255, 255, 0.3)'}
                  size="1rem"
                />
              </ActionIcon>
            </LoginPopover>
          )}
          {!canVote && (
            <ActionIcon variant="transparent" size="sm" onClick={handleRemove}>
              <IconX strokeWidth={2.5} size=".75rem" />
            </ActionIcon>
          )}
        </Group>
      </Badge>
    </Link>
  );
}

let timer: NodeJS.Timeout | undefined;
const debounce = (func: () => void, timeout = 1000) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    func();
  }, timeout);
};
