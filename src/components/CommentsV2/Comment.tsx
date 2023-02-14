import { GroupProps, Group, ActionIcon, Anchor, Menu, Stack, Text, Button } from '@mantine/core';
import { useMemo, useState } from 'react';
import { useCommentsContext } from './CommentsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { InfiniteCommentResults } from '~/server/controllers/commentv2.controller';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { IconDotsVertical, IconTrash, IconEdit, IconFlag, IconArrowBackUp } from '@tabler/icons';
import Link from 'next/link';
import { CommentForm } from '~/components/Comments/CommentForm';
import { DeleteComment } from '~/components/Comments/DeleteComment';
import { DaysFromNow } from '~/components/Dates/DaysFromNow';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { openContext } from '~/providers/CustomModalsProvider';
import { ReportEntity } from '~/server/schema/report.schema';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import create from 'zustand';
import { Reactions, ReactionMetrics } from '~/components/Reaction/Reactions';
import { ReviewReactions } from '@prisma/client';

type Store = {
  id?: number;
  setId: (id?: number) => void;
};

const useStore = create<Store>((set) => ({
  setId: (id) => set(() => ({ id })),
}));

type CommentProps = Omit<GroupProps, 'children'> & {
  comment: InfiniteCommentResults['comments'][0];
};

export function Comment({ comment, ...groupProps }: CommentProps) {
  const { entityId, entityType } = useCommentsContext();
  const currentUser = useCurrentUser();
  const id = useStore((state) => state.id);
  const setId = useStore((state) => state.setId);
  const isOwner = currentUser?.id === comment.user.id;
  const isMod = currentUser?.isModerator ?? false;
  const isMuted = currentUser?.muted ?? false;
  const editing = id === comment.id;
  const [replying, setReplying] = useState(false);

  return (
    <Group align="flex-start" noWrap {...groupProps}>
      <UserAvatar user={comment.user} size="md" linkToProfile />
      <Stack spacing={0} style={{ flex: 1 }}>
        <Group position="apart">
          {/* AVATAR */}
          <Group spacing={8} align="center">
            <Link href={`/user/${comment.user.username}`} passHref>
              <Anchor variant="text" size="sm" weight="bold">
                {comment.user.username}
              </Anchor>
            </Link>
            <Text color="dimmed" size="xs">
              <DaysFromNow date={comment.createdAt} />
            </Text>
          </Group>
          {/* CONTROLS */}
          <Menu position="bottom-end">
            <Menu.Target>
              <ActionIcon size="xs" variant="subtle">
                <IconDotsVertical size={14} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {(isOwner || currentUser?.isModerator) && (
                <>
                  <DeleteComment id={comment.id} entityId={entityId} entityType={entityType}>
                    <Menu.Item icon={<IconTrash size={14} stroke={1.5} />} color="red">
                      Delete comment
                    </Menu.Item>
                  </DeleteComment>
                  {(!currentUser?.muted || currentUser?.isModerator) && (
                    <Menu.Item
                      icon={<IconEdit size={14} stroke={1.5} />}
                      onClick={() => setId(comment.id)}
                    >
                      Edit comment
                    </Menu.Item>
                  )}
                </>
              )}
              {(!currentUser || !isOwner) && (
                <LoginRedirect reason="report-model">
                  <Menu.Item
                    icon={<IconFlag size={14} stroke={1.5} />}
                    onClick={() =>
                      openContext('report', {
                        entityType: ReportEntity.Comment,
                        entityId: comment.id,
                      })
                    }
                  >
                    Report
                  </Menu.Item>
                </LoginRedirect>
              )}
            </Menu.Dropdown>
          </Menu>
        </Group>
        {/* COMMENT / EDIT COMMENT */}
        <Stack style={{ flex: 1 }}>
          {!editing ? (
            <>
              <RenderHtml
                html={comment.content}
                sx={(theme) => ({ fontSize: theme.fontSizes.sm })}
              />
              {/* COMMENT INTERACTION */}
              <Group spacing={4}>
                <CommentReactions comment={comment} />
                {/* TODO.comments - locked threads? */}
                {currentUser && !isOwner && !isMuted && (
                  <Button
                    variant="subtle"
                    size="xs"
                    radius="xl"
                    onClick={() => setReplying(true)}
                    compact
                  >
                    <Group spacing={4}>
                      <IconArrowBackUp size={14} />
                      Reply
                    </Group>
                  </Button>
                )}
              </Group>
            </>
          ) : (
            <CommentForm
              comment={comment}
              entityId={entityId}
              entityType={entityType}
              onCancel={() => setId(undefined)}
              autoFocus
            />
          )}
        </Stack>
      </Stack>
    </Group>
  );
}

function CommentReactions({ comment }: { comment: InfiniteCommentResults['comments'][0] }) {
  const currentUser = useCurrentUser();
  const userReactions = comment.reactions.filter((x) => x.user.id === currentUser?.id);
  const metrics = useMemo(
    (): ReactionMetrics => ({
      likeCount: comment.reactions.filter((x) => x.reaction === ReviewReactions.Like).length,
      dislikeCount: comment.reactions.filter((x) => x.reaction === ReviewReactions.Dislike).length,
      heartCount: comment.reactions.filter((x) => x.reaction === ReviewReactions.Heart).length,
      laughCount: comment.reactions.filter((x) => x.reaction === ReviewReactions.Laugh).length,
      cryCount: comment.reactions.filter((x) => x.reaction === ReviewReactions.Cry).length,
    }),
    [comment.reactions]
  );

  return (
    <Reactions
      reactions={userReactions}
      entityId={comment.id}
      entityType="comment"
      metrics={metrics}
    />
  );
}
