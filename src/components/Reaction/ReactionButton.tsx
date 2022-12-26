import { IconArrowRight, IconCheck, IconHeart, IconX } from '@tabler/icons';
import { ToggleReactionInput } from '~/server/schema/reaction.schema';
import { trpc } from '~/utils/trpc';
import { useState } from 'react';
import { Button, useMantineTheme } from '@mantine/core';
import { useDidUpdate } from '@mantine/hooks';
import { ReviewReactions } from '@prisma/client';

const reactionIcons = {
  [ReviewReactions.Heart]: IconHeart,
  [ReviewReactions.Like]: IconArrowRight,
  [ReviewReactions.Dislike]: IconArrowRight,
  [ReviewReactions.Laugh]: IconArrowRight,
  [ReviewReactions.Cry]: IconArrowRight,
};

type ReactionButtonProps = ToggleReactionInput & {
  userReacted?: boolean;
  count?: number;
  disabled: boolean;
};

export const ReactionButton = ({
  entityId,
  entityType,
  reaction,
  userReacted,
  count: initialCount,
  disabled,
}: ReactionButtonProps) => {
  const [hasReacted, setHasReacted] = useState(!!userReacted);
  const [count, setCount] = useState(initialCount ?? 0);
  const { mutate, isLoading } = trpc.reaction.toggle.useMutation();

  const toggleReaction = () => {
    setCount((c) => (hasReacted ? c - 1 : c + 1));
    setHasReacted((r) => !r);
  };

  useDidUpdate(() => {
    mutate({
      entityId,
      entityType,
      reaction,
    });
  }, [hasReacted]);

  const Icon = reactionIcons[reaction];
  return (
    <Button
      variant={hasReacted ? 'filled' : 'default'}
      leftIcon={<Icon size={18} />}
      onClick={!disabled ? toggleReaction : undefined}
    >
      {count}
    </Button>
  );
};
