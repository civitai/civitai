import { Button, useMantineTheme, Badge, Center } from '@mantine/core';
import { IconArrowRight, IconCheck, IconHeart, IconX } from '@tabler/icons';
import { ToggleReactionInput } from '~/server/schema/reaction.schema';
import { trpc } from '~/utils/trpc';
import { useState } from 'react';
import { useDidUpdate } from '@mantine/hooks';
import { ReviewReactions } from '@prisma/client';
import { IconBadge } from '~/components/IconBadge/IconBadge';

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
  const theme = useMantineTheme();
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
    <Badge
      // variant={theme.colorScheme === 'dark' ? 'light' : 'filled'}
      variant={'light'}
      // variant="outline"
      color={hasReacted ? 'pink' : 'gray'}
      leftSection={
        <Center>
          <Icon size={18} />
        </Center>
      }
      sx={{ userSelect: 'none', ...(!disabled && { cursor: 'pointer' }) }}
      onClick={!disabled ? toggleReaction : undefined}
      size="lg"
      px={5}
      // px={4}
      // radius="lg"
      // py="md"
    >
      {count}
    </Badge>
  );
};
