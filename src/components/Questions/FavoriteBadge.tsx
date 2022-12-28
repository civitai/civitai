import { useMantineTheme, Badge, Center } from '@mantine/core';
import { IconHeart } from '@tabler/icons';
import { ToggleReactionInput } from '~/server/schema/reaction.schema';
import { trpc } from '~/utils/trpc';
import { useState } from 'react';
import { useDidUpdate } from '@mantine/hooks';
import { ReviewReactions } from '@prisma/client';

type ReactionButtonProps = Omit<ToggleReactionInput, 'reaction'> & {
  userReacted?: boolean;
  count?: number;
  disabled?: boolean;
};

export const FavoriteBadge = ({
  entityId,
  entityType,
  userReacted,
  count: initialCount,
  disabled,
}: ReactionButtonProps) => {
  const theme = useMantineTheme();
  const [hasReacted, setHasReacted] = useState(!!userReacted);
  const [count, setCount] = useState(hasReacted && !initialCount ? 1 : initialCount ?? 0);
  const { mutate, isLoading } = trpc.reaction.toggle.useMutation();

  const toggleReaction = () => {
    setCount((c) => (hasReacted ? c - 1 : c + 1));
    setHasReacted((r) => !r);
  };

  useDidUpdate(() => {
    mutate({
      entityId,
      entityType,
      reaction: ReviewReactions.Heart,
    });
  }, [hasReacted]);

  return (
    <Badge
      variant={'light'}
      color={hasReacted ? 'pink' : 'gray'}
      leftSection={
        <Center>
          <IconHeart
            size={18}
            color={hasReacted ? theme.colors.red[6] : undefined}
            style={{ fill: hasReacted ? theme.colors.red[6] : undefined }}
          />
        </Center>
      }
      sx={{ userSelect: 'none', ...(!disabled && { cursor: 'pointer' }) }}
      onClick={!disabled ? toggleReaction : undefined}
      size="lg"
      px={5}
    >
      {count}
    </Badge>
  );
};
