import { IconCheck, IconHeart, IconX } from '@tabler/icons';
import { z } from 'zod';
import { getReactionSchema } from '~/server/schema/reaction.schema';
import { trpc } from '~/utils/trpc';
import { useState } from 'react';
import { Button, useMantineTheme } from '@mantine/core';
import { useDidUpdate } from '@mantine/hooks';

const types = {
  heart: IconHeart,
  check: IconCheck,
  cross: IconX,
};

type ReactionButtonProps = {
  reactionId?: number;
  reactionType: keyof typeof types;
  count?: number;
  userReaction?: Date | null;
  disabled?: boolean;
} & z.infer<typeof getReactionSchema>;

export function ReactionButton({
  reactionId,
  reactionType,
  entityType,
  entityId,
  count: initialCount,
  userReaction,
  disabled,
}: ReactionButtonProps) {
  const theme = useMantineTheme();
  const [hasReaction, setHasReaction] = useState(!!userReaction);
  const [count, setCount] = useState(initialCount ?? 0);
  const { mutate, isLoading } = trpc.reaction.upsert.useMutation();

  const toggleReaction = () => {
    setCount((c) => (hasReaction ? c - 1 : c + 1));
    setHasReaction((r) => !r);
  };

  useDidUpdate(() => {
    mutate({
      id: reactionId,
      entityId,
      entityType,
      [reactionType]: hasReaction,
    });
  }, [hasReaction]);

  const Icon = types[reactionType];

  return (
    <Button
      variant={hasReaction ? 'filled' : 'default'}
      leftIcon={<Icon size={18} />}
      onClick={!disabled ? toggleReaction : undefined}
      size="xs"
    >
      {count}
    </Button>
  );
}
