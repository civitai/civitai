import { Anchor, Badge, Button, Card, Group, Text, ThemeIcon } from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';
import type { ReactNode } from 'react';
import { useRef, useState } from 'react';
import {
  IconExclamationCircle,
  IconLock,
  IconMessageCircle2,
  IconPinned,
  IconTrash,
} from '@tabler/icons-react';

import { CommentEditor } from '~/components/CommentsV3/CommentComposer';
import { CommentMenu } from '~/components/CommentsV3/CommentMenu';
import { useCommentSection } from '~/components/CommentsV3/CommentSectionContext';
import {
  HiddenCommentLabel,
  HideAgainButton,
  useHiddenCommentReveal,
} from '~/components/CommentsV3/HiddenComment';
import type { CommentV3Comment } from '~/components/CommentsV3/types';
import { useCommentReactions } from '~/components/CommentsV3/useCommentReactions';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { triggerRoutedDialog } from '~/components/Dialog/RoutedDialogLink';
import { Reactions } from '~/components/Reaction/Reactions';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useIsomorphicLayoutEffect } from '~/hooks/useIsomorphicLayoutEffect';
import { abbreviateNumber } from '~/utils/number-helpers';

export function CommentDiscussionItem({ data: comment, modelUserId }: Props) {
  const currentUser = useCurrentUser();
  const { locked, created, hiddenOnly } = useCommentSection();
  // The hidden-comments dialog lists them to be read, so it does not fold them again.
  const { concealed, reveal, conceal } = useHiddenCommentReveal(comment.hidden && !hiddenOnly);
  const [editing, setEditing] = useState(false);
  const author = comment.user;
  const replyCount = comment.replyCount + (created[comment.id]?.length ?? 0);

  const { metrics, reactions: myReactions } = useCommentReactions(comment);

  return (
    <Card radius="md" p="md" withBorder>
      <Group align="flex-start" justify="space-between" wrap="nowrap" mb="xs">
        {!author ? (
          <Group gap={6} wrap="nowrap">
            <IconTrash size={16} className="text-gray-6 dark:text-dark-2" />
            <Text size="sm" c="dimmed" fs="italic">
              This comment was deleted
            </Text>
          </Group>
        ) : concealed ? (
          <HiddenCommentLabel onShow={reveal} />
        ) : (
          <UserAvatar
            user={author}
            subText={<DaysFromNow date={comment.createdAt} />}
            subTextForce
            avatarSize="md"
            badge={
              modelUserId != null && author.id === modelUserId ? (
                <Badge size="xs" color="violet">
                  OP
                </Badge>
              ) : null
            }
            withUsername
            linkToProfile
          />
        )}
        <Group gap={4} wrap="nowrap">
          {author && comment.pinnedAt && (
            <Tooltip label="Pinned">
              <ThemeIcon size="sm" color="orange">
                <IconPinned size={16} stroke={2} />
              </ThemeIcon>
            </Tooltip>
          )}
          <CommentMenu comment={comment} lockedAbove={locked} onEdit={() => setEditing(true)} />
        </Group>
      </Group>

      {editing ? (
        <CommentEditor editing={comment} autoFocus onDone={() => setEditing(false)} />
      ) : (
        author &&
        !concealed && (
          <ClampedContent commentId={comment.id}>
            <RenderHtml
              html={comment.content}
              className="text-sm"
              withMentions
              withProfanityFilter
              allowStickers
            />
          </ClampedContent>
        )
      )}

      <Group mt="sm" align="flex-start" justify="space-between" wrap="nowrap">
        <Group gap={4}>
          {author && !concealed && (
            <Reactions
              reactions={myReactions}
              entityId={comment.id}
              entityType="comment"
              metrics={metrics}
            />
          )}
          {comment.hidden && !hiddenOnly && !concealed && <HideAgainButton onClick={conceal} />}
        </Group>
        <Group gap={4} wrap="nowrap">
          {currentUser?.isModerator && comment.tosViolation && (
            <Tooltip label="Has TOS Violation">
              <ThemeIcon color="orange" size="xs">
                <IconExclamationCircle />
              </ThemeIcon>
            </Tooltip>
          )}
          {comment.locked && (
            <Tooltip label="Replies locked">
              <ThemeIcon color="yellow" size="xs">
                <IconLock />
              </ThemeIcon>
            </Tooltip>
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
              <Text>{abbreviateNumber(replyCount)}</Text>
            </Group>
          </Button>
        </Group>
      </Group>
    </Card>
  );
}

type Props = { data: CommentV3Comment; modelUserId?: number };

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
