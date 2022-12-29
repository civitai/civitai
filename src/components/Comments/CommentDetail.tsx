import { ActionIcon, Anchor, Group, Menu, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { InfiniteCommentResults } from '~/server/controllers/commentv2.controller';
import { CommentForm } from '~/components/Comments/CommentForm';
import { CommentConnectorInput } from '~/server/schema/commentv2.schema';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import Link from 'next/link';
import { daysFromNow } from '~/utils/date-helpers';
import { IconDotsVertical, IconEdit, IconFlag, IconTrash } from '@tabler/icons';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { DeleteComment } from '~/components/Comments/DeleteComment';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { ReportEntity } from '~/server/schema/report.schema';
import { useRoutedContext } from '~/routed-context/routed-context.provider';

type CommentDetailProps = {
  comment: InfiniteCommentResults['comments'][0];
} & CommentConnectorInput;

export function CommentDetail({ comment, entityId, entityType }: CommentDetailProps) {
  const { openContext } = useRoutedContext();
  const currentUser = useCurrentUser();
  const [editing, setEditing] = useState(false);
  const isOwner = currentUser?.id === comment.user.id;

  return (
    <Group align="flex-start" noWrap>
      <UserAvatar user={comment.user} size="md" linkToProfile />
      <Stack spacing={0} style={{ flex: 1 }}>
        <Group position="apart">
          <Group spacing={8} align="center">
            <Link href={`/user/${comment.user.username}`} passHref>
              <Anchor variant="text" size="sm" weight="bold">
                {comment.user.username}
              </Anchor>
            </Link>
            {/* TODO - OP ??? this should be better defined */}
            <Text color="dimmed" size="xs">
              {daysFromNow(comment.createdAt)}
            </Text>
          </Group>
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
                  <Menu.Item
                    icon={<IconEdit size={14} stroke={1.5} />}
                    onClick={() => setEditing(true)}
                  >
                    Edit comment
                  </Menu.Item>
                </>
              )}
              {(!currentUser || !isOwner) && (
                <LoginRedirect reason="report-model">
                  <Menu.Item
                    icon={<IconFlag size={14} stroke={1.5} />}
                    onClick={() =>
                      openContext('report', {
                        type: ReportEntity.Comment,
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
        <Stack style={{ flex: 1 }}>
          {editing ? (
            <CommentForm
              comment={comment}
              entityId={entityId}
              entityType={entityType}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <RenderHtml html={comment.content} sx={(theme) => ({ fontSize: theme.fontSizes.sm })} />
          )}
        </Stack>
      </Stack>
    </Group>
  );
}
