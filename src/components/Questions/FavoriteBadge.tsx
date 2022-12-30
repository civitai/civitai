import { useMantineTheme, Badge, Center } from '@mantine/core';
import { IconHeart } from '@tabler/icons';
import { ToggleReactionInput } from '~/server/schema/reaction.schema';
import { trpc } from '~/utils/trpc';
import { useState } from 'react';
import { useDidUpdate } from '@mantine/hooks';
import { ReviewReactions } from '@prisma/client';
import { ReactionBadge } from '~/components/Questions/ReactionBadge';

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
    <ReactionBadge
      color={hasReacted ? 'pink' : undefined}
      leftIcon={
        <IconHeart
          size={18}
          color={hasReacted ? theme.colors.red[6] : undefined}
          style={{ fill: hasReacted ? theme.colors.red[6] : undefined }}
        />
      }
      onClick={!disabled ? toggleReaction : undefined}
    >
      {count}
    </ReactionBadge>
  );
};
