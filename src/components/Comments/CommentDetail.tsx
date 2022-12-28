import { ActionIcon, Anchor, Group, Menu, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { InfiniteCommentResults } from '~/server/controllers/commentv2.controller';
import { CommentForm } from '~/components/Comments/CommentForm';
import { CommentConnectorInput } from '~/server/schema/commentv2.schema';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import Link from 'next/link';
import { daysFromNow } from '~/utils/date-helpers';
import { IconDotsVertical } from '@tabler/icons';

type CommentDetailProps = {
  comment: InfiniteCommentResults['comments'][0];
} & CommentConnectorInput;

export function CommentDetail({ comment, entityId, entityType }: CommentDetailProps) {
  const [editing, setEditing] = useState(false);

  const content = editing ? (
    <CommentForm comment={comment} entityId={entityId} entityType={entityType} />
  ) : (
    <RenderHtml html={comment.content} sx={(theme) => ({ fontSize: theme.fontSizes.sm })} />
  );

  return (
    <Group align="flex-start" noWrap>
      <UserAvatar user={comment.user} size="md" linkToProfile />
      <Stack spacing="xs">
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
              <Menu.Item></Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Stack>
    </Group>
  );
}
