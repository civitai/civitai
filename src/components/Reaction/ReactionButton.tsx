import { IconArrowRight, IconCheck, IconHeart, IconX } from '@tabler/icons';
import { z } from 'zod';
import { ReactionEntityType, ToggleReactionInput } from '~/server/schema/reaction.schema';
import { trpc } from '~/utils/trpc';
import { useState } from 'react';
import { Button, useMantineTheme } from '@mantine/core';
import { useDidUpdate } from '@mantine/hooks';
import { ReviewReactions } from '@prisma/client';

const reactionIcons = {
  [ReviewReactions.Heart]: IconHeart,
  [ReviewReactions.Check]: IconCheck,
  [ReviewReactions.Cross]: IconX,
  [ReviewReactions.Like]: IconArrowRight,
  [ReviewReactions.Dislike]: IconArrowRight,
  [ReviewReactions.Laugh]: IconArrowRight,
  [ReviewReactions.Cry]: IconArrowRight,
};

// type ReactionButtonOldProps = {
//   reactionId?: number;
//   reactionType: keyof typeof types;
//   count?: number;
//   userReaction?: Date | null;
//   disabled?: boolean;
// };

// export function ReactionOldButton({
//   reactionId,
//   reactionType,
//   entityType,
//   entityId,
//   count: initialCount,
//   userReaction,
//   disabled,
// }: ReactionButtonOldProps) {
//   const theme = useMantineTheme();
//   const [hasReaction, setHasReaction] = useState(!!userReaction);
//   const [count, setCount] = useState(initialCount ?? 0);
//   const { mutate, isLoading } = trpc.reaction.upsert.useMutation();

//   const toggleReaction = () => {
//     setCount((c) => (hasReaction ? c - 1 : c + 1));
//     setHasReaction((r) => !r);
//   };

//   useDidUpdate(() => {
//     mutate({
//       id: reactionId,
//       entityId,
//       entityType,
//       [reactionType]: hasReaction,
//     });
//   }, [hasReaction]);

//   const Icon = types[reactionType];

//   return (
//     <Button
//       variant={hasReaction ? 'filled' : 'default'}
//       leftIcon={<Icon size={18} />}
//       onClick={!disabled ? toggleReaction : undefined}
//       size="xs"
//     >
//       {count}
//     </Button>
//   );
// }

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
