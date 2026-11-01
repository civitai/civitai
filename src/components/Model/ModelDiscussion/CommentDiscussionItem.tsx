import { Anchor, Badge, Button, Card, Group, Text, ThemeIcon, Tooltip } from '@mantine/core';
import type { ReactNode } from 'react';
import { useRef, useState } from 'react';
import type { ReviewReactions } from '~/shared/utils/prisma/enums';
import {
  IconExclamationCircle,
  IconLock,
  IconMessageCircle2,
  IconPinned,
} from '@tabler/icons-react';

import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { triggerRoutedDialog } from '~/components/Dialog/RoutedDialogLink';
import { CommentDiscussionMenu } from '~/components/Model/ModelDiscussion/CommentDiscussionMenu';
import { ReactionPicker } from '~/components/ReactionPicker/ReactionPicker';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useToggleCommentReaction } from '~/components/CommentSection/useToggleCommentReaction';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsomorphicLayoutEffect } from '~/hooks/useIsomorphicLayoutEffect';
import type { CommentGetAllItem } from '~/types/router';
import { abbreviateNumber } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

export function CommentDiscussionItem({ data: comment, modelUserId }: Props) {
  const currentUser = useCurrentUser();

  const { data: reactions = [] } = trpc.comment.getReactions.useQuery(
    { commentId: comment.id },
    { initialData: comment.reactions, staleTime: Infinity, refetchOnWindowFocus: false }
  );
  const { data: commentCount = 0 } = trpc.comment.getCommentsCount.useQuery(
    { id: comment.id },
    { initialData: comment._count.comments, staleTime: Infinity, refetchOnWindowFocus: false }
  );

  const toggleCommentReaction = useToggleCommentReaction(comment.id);
  const handleReactionClick = (reaction: ReviewReactions) => {
    toggleCommentReaction.toggle(reaction);
  };

  return (
    <Card radius="md" p="md" withBorder>
      <Group align="flex-start" justify="space-between" wrap="nowrap" mb="xs">
        <UserAvatar
          user={comment.user}
          subText={<DaysFromNow date={comment.createdAt} />}
          subTextForce
          avatarSize="md"
          badge={
            modelUserId != null && comment.user.id === modelUserId ? (
              <Badge size="xs" color="violet">
                OP
              </Badge>
            ) : null
          }
          withUsername
          linkToProfile
        />
        <Group gap={4} wrap="nowrap">
          {comment.pinnedAt && (
            <Tooltip label="Pinned">
              <ThemeIcon size="sm" color="orange">
                <IconPinned size={16} stroke={2} />
              </ThemeIcon>
            </Tooltip>
          )}
          <CommentDiscussionMenu comment={comment} hideLockOption modelUserId={modelUserId} />
        </Group>
      </Group>

      <ClampedContent commentId={comment.id}>
        <RenderHtml
          html={comment.content}
          className="text-sm"
          withMentions
          withProfanityFilter
          allowStickers
        />
      </ClampedContent>

      <Group mt="sm" align="flex-start" justify="space-between" wrap="nowrap">
        <ReactionPicker
          reactions={reactions}
          onSelect={handleReactionClick}
          disabled={toggleCommentReaction.isPending}
        />
        <Group gap={4} wrap="nowrap">
          {currentUser?.isModerator && comment.tosViolation && (
            <Tooltip label="Has TOS Violation">
              <ThemeIcon color="orange" size="xs">
                <IconExclamationCircle />
              </ThemeIcon>
            </Tooltip>
          )}
          {comment.locked && (
            <ThemeIcon color="yellow" size="xs">
              <IconLock />
            </ThemeIcon>
          )}
          <Button
            radius="xl"
            variant="subtle"
            onClick={() =>
              triggerRoutedDialog({ name: 'commentThread', state: { commentId: comment.id } })
            }
            size="compact-xs"
          >
            <Group gap={2} wrap="nowrap">
              <IconMessageCircle2 size={14} />
              <Text>{abbreviateNumber(commentCount)}</Text>
            </Group>
          </Button>
        </Group>
      </Group>
    </Card>
  );
}

type Props = { data: CommentGetAllItem; modelUserId?: number };

const CLAMP_HEIGHT = 100;

/**
 * Kept per comment so a card remounted by the virtualizer renders at its final height. The
 * virtualizer measures a card when it attaches, before this component's layout effect can add
 * the Show More control, so deciding on mount shifted every card below it in the column.
 */
const clampStateById = new Map<number, { overflows: boolean; expanded: boolean }>();
const CLAMP_CACHE_LIMIT = 500;

function rememberClampState(id: number, state: { overflows: boolean; expanded: boolean }) {
  clampStateById.delete(id);
  clampStateById.set(id, state);
  if (clampStateById.size > CLAMP_CACHE_LIMIT)
    clampStateById.delete(clampStateById.keys().next().value!);
}

function ClampedContent({ commentId, children }: { commentId: number; children: ReactNode }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const cached = clampStateById.get(commentId);
  const [overflows, setOverflows] = useState(cached?.overflows ?? false);
  const [expanded, setExpanded] = useState(cached?.expanded ?? false);

  useIsomorphicLayoutEffect(() => {
    rememberClampState(commentId, { overflows, expanded });
  }, [commentId, overflows, expanded]);

  useIsomorphicLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const measure = () => setOverflows(el.offsetHeight > CLAMP_HEIGHT);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div style={{ maxHeight: expanded ? undefined : CLAMP_HEIGHT, overflow: 'hidden' }}>
        <div ref={contentRef}>{children}</div>
      </div>
      {overflows && (
        <Anchor component="button" type="button" onClick={() => setExpanded((v) => !v)}>
          <Text size="sm">{expanded ? 'Hide' : 'Show More'}</Text>
        </Anchor>
      )}
    </>
  );
}
