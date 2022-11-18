import { Button, Group, Popover, Text, Tooltip } from '@mantine/core';
import { ReviewReactions } from '@prisma/client';
import { IconMoodSmile, IconPlus } from '@tabler/icons';
import groupBy from 'lodash/groupBy';
import { Session } from 'next-auth';
import { useSession } from 'next-auth/react';
import { createContext, useContext, useMemo } from 'react';
import { ReactionDetails } from '~/server/selectors/review.selector';
import { toStringList } from '~/utils/array-helpers';

type ReactionToEmoji = { [k in ReviewReactions]: string };
const availableReactions: ReactionToEmoji = {
  [ReviewReactions.Like]: '👍',
  [ReviewReactions.Dislike]: '👎',
  [ReviewReactions.Heart]: '❤️',
  [ReviewReactions.Laugh]: '😂',
  [ReviewReactions.Cry]: '😢',
};

const ReactionPickerContext = createContext<{
  onEmojiClick: (reaction: ReviewReactions) => void;
  reactions: ReactionDetails[];
  disabled: boolean;
  user?: Session['user'];
}>({
  onEmojiClick: (reaction) => reaction,
  reactions: [],
  disabled: false,
});
const useReactionPickerContext = () => useContext(ReactionPickerContext);

export function ReactionPicker({ reactions, disabled = false, onSelect }: ReactionPickerProps) {
  const { data: session } = useSession();
  const currentUser = session?.user;
  const groupedReactions = useMemo(() => groupBy(reactions, 'reaction'), [reactions]);

  return (
    <ReactionPickerContext.Provider
      value={{ onEmojiClick: onSelect, user: currentUser, reactions, disabled }}
    >
      <Group spacing={4} mt="sm" align="center">
        <Popover shadow="md" position="top-start" withArrow withinPortal>
          <Popover.Target>
            <Button variant="subtle" size="xs" color="gray" radius="xl" compact>
              <Group spacing={2}>
                <IconPlus size={14} stroke={1.5} />
                <IconMoodSmile size={14} stroke={1.5} />
              </Group>
            </Button>
          </Popover.Target>
          <Popover.Dropdown p={4}>
            {session ? (
              <ReactionSelector />
            ) : (
              <Text color="dimmed" size="xs" px="xs">
                You must be logged in to react
              </Text>
            )}
          </Popover.Dropdown>
        </Popover>
        {Object.entries(groupedReactions).map(([key, value], index) => (
          <ReactionBadge key={index} reaction={key as ReviewReactions} reactions={value} />
        ))}
      </Group>
    </ReactionPickerContext.Provider>
  );
}

type ReactionPickerProps = {
  reactions: ReactionDetails[];
  onSelect: (reaction: ReviewReactions) => void;
  disabled?: boolean;
};

function ReactionBadge({ reaction, reactions }: ReactionBadgeProps) {
  const { onEmojiClick, user, disabled } = useReactionPickerContext();
  const tooltip = toStringList(
    reactions.map((reaction) =>
      reaction.user.username === user?.username ? 'You' : reaction.user.username ?? '<deleted user>'
    )
  );
  const reacted = reactions.findIndex((reaction) => reaction.user.username === user?.username) > -1;
  const canClick = user && !disabled;

  return (
    <Tooltip label={tooltip} withArrow>
      <Button
        size="xs"
        radius="xl"
        variant="light"
        color={reacted ? 'blue' : 'gray'}
        onClick={canClick ? () => onEmojiClick(reaction) : undefined}
        compact
      >
        <Group spacing={4} align="center">
          <Text inherit>{availableReactions[reaction]}</Text>
          <Text inherit>{reactions.length}</Text>
        </Group>
      </Button>
    </Tooltip>
  );
}

type ReactionBadgeProps = {
  reaction: ReviewReactions;
  reactions: ReactionPickerProps['reactions'];
};

function ReactionSelector() {
  const { onEmojiClick, disabled, user } = useReactionPickerContext();
  const canClick = user && !disabled;

  return (
    <Group spacing={4}>
      {Object.entries(availableReactions).map(([reaction, emoji], index) => (
        <Tooltip key={index} label={reaction}>
          <Button
            size="xs"
            radius="sm"
            variant="subtle"
            onClick={canClick ? () => onEmojiClick(reaction as ReviewReactions) : undefined}
          >
            {emoji}
          </Button>
        </Tooltip>
      ))}
    </Group>
  );
}
