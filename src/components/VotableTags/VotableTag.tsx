import { VotableTagConnectorInput } from '~/server/schema/tag.schema';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { ActionIcon, Badge, Group, useMantineTheme } from '@mantine/core';
import { useCallback, useRef } from 'react';
import { TagType } from '@prisma/client';
import { IconArrowBigDown, IconArrowBigTop } from '@tabler/icons';
import { LoginPopover } from '~/components/LoginPopover/LoginPopover';

type VotableTagProps = VotableTagConnectorInput & {
  tagId: number;
  vote?: number;
  type: TagType;
  name: string;
  score: number;
  onChange: (changed: { tagId: number; vote: number }) => void;
};

type VotableTagStore = {
  votes: Record<string, number>;
  setVote: (
    vote: VotableTagConnectorInput & {
      tagId: number;
      vote: number;
    }
  ) => void;
};

const getKey = ({ entityType, entityId, tagId }: VotableTagConnectorInput & { tagId: number }) =>
  `${entityType}_${entityId}_${tagId}`;

const useStore = create<VotableTagStore>()(
  immer((set) => ({
    votes: {},
    setVote: ({ entityType, entityId, tagId, vote }) => {
      const key = getKey({ entityType, entityId, tagId });
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
  vote: initialVote = 0,
  type,
  name,
  score,
  onChange,
}: VotableTagProps) {
  const clickedRef = useRef(false);
  const key = getKey({ entityType, entityId, tagId });
  const vote = useStore(useCallback((state) => state.votes[key], [key])) ?? initialVote;
  const setVote = useStore((state) => state.setVote);

  const theme = useMantineTheme();
  const isModeration = type === 'Moderation';
  const voteColor = isModeration ? theme.colors.red[7] : theme.colors.blue[5];
  const opacity = 0.2 + (Math.min(score, 10) / 10) * 0.8;

  const runDebouncer = (fn: () => void) => {
    if (!clickedRef.current) {
      clickedRef.current = true;
      fn();
      debounce(() => (clickedRef.current = false), 500);
    }
  };

  const handleUpvote = () =>
    runDebouncer(() => {
      const value = vote !== 1 ? 1 : 0;
      setVote({ entityId, entityType, tagId, vote: value });
      onChange({ tagId, vote: value });
    });

  const handleDownvote = () =>
    runDebouncer(() => {
      const value = vote !== -1 ? -1 : 0;
      setVote({ entityId, entityType, tagId, vote: value });
      onChange({ tagId, vote: value });
    });

  return (
    <Badge
      radius="xs"
      key={tagId}
      variant={isModeration ? 'light' : 'filled'}
      color={isModeration ? 'red' : 'gray'}
      style={{ opacity }}
      px={0}
    >
      <Group spacing={0}>
        <LoginPopover>
          <ActionIcon
            variant="transparent"
            size="sm"
            onClick={handleUpvote}
            color={vote === 1 ? voteColor : undefined}
          >
            <IconArrowBigTop
              strokeWidth={0}
              fill={vote === 1 ? voteColor : 'rgba(255, 255, 255, 0.3)'}
              size="1rem"
            />
          </ActionIcon>
        </LoginPopover>
        <span>{name}</span>
        <LoginPopover>
          <ActionIcon variant="transparent" size="sm" onClick={handleDownvote}>
            <IconArrowBigDown
              strokeWidth={0}
              fill={vote === -1 ? voteColor : 'rgba(255, 255, 255, 0.3)'}
              size="1rem"
            />
          </ActionIcon>
        </LoginPopover>
      </Group>
    </Badge>
  );
}

let timer: NodeJS.Timeout | undefined;
const debounce = (func: () => void, timeout = 1000) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    func();
  }, timeout);
};
