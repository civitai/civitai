import { Button, Group, Popover, Text, Tooltip } from '@mantine/core';
import { ReviewReactions } from '@prisma/client';
import { IconMoodSmile, IconPlus } from '@tabler/icons';
import groupBy from 'lodash/groupBy';
import { Session } from 'next-auth';
import { useSession } from 'next-auth/react';
import { createContext, useContext, useMemo } from 'react';
import { ToggleReactionInput } from '~/server/schema/reaction.schema';
import { ReactionDetails } from '~/server/selectors/reaction.selector';
import { ReviewGetReactions } from '~/types/router';
import { toStringList } from '~/utils/array-helpers';

type ReactionMetrics = {
  likeCount?: number;
  dislikeCount?: number;
  heartCount?: number;
  laughCount?: number;
  cryCount?: number;
};

type ReactionToEmoji = { [k in ReviewReactions]: string };
const availableReactions: ReactionToEmoji = {
  [ReviewReactions.Like]: '👍',
  [ReviewReactions.Dislike]: '👎',
  [ReviewReactions.Heart]: '❤️',
  [ReviewReactions.Laugh]: '😂',
  [ReviewReactions.Cry]: '😢',
};

type ReactionsProps = ToggleReactionInput & {
  reactions: ReactionDetails[];
  metrics?: ReactionMetrics;
};

export function Reactions({ reactions, metrics, entityType, entityId }: ReactionsProps) {
  return <></>;
}
