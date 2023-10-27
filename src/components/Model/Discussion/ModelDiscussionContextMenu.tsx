import { GroupProps, Group, ActionIcon, Menu, Stack, Text, Button, Box } from '@mantine/core';
import {
  IconDotsVertical,
  IconTrash,
  IconEdit,
  IconFlag,
  IconArrowBackUp,
} from '@tabler/icons-react';
import { useCommentsContext } from '~/components/CommentsV2';
import { useCommentV2Context } from '~/components/CommentsV2/Comment/CommentProvider';
import { DeleteComment } from '~/components/CommentsV2/Comment/DeleteComment';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { openContext } from '~/providers/CustomModalsProvider';
import { ReportEntity } from '~/server/schema/report.schema';

export function ModelDiscussionContextMenu() {
  const { entityId, entityType } = useCommentsContext();
  const { canDelete, canEdit, canReply, badge, canReport, comment } = useCommentV2Context();

  const handleEditClick = () => {
    // TODO - open comment edit modal
  };

  const handleReportClick = () =>
    openContext('report', {
      entityType: ReportEntity.CommentV2,
      entityId: comment.id,
    });

  return (
    <Menu>
      <Menu.Target>
        <ActionIcon size="xs" variant="subtle">
          <IconDotsVertical size={14} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {canDelete && (
          <DeleteComment entityId={entityId} entityType={entityType} id={comment.id}>
            {({ onClick }) => (
              <Menu.Item icon={<IconTrash size={14} stroke={1.5} />} color="red" onClick={onClick}>
                Delete Comment
              </Menu.Item>
            )}
          </DeleteComment>
        )}
        {canEdit && (
          <Menu.Item icon={<IconEdit size={14} stroke={1.5} />} onClick={handleEditClick}>
            Edit Comment
          </Menu.Item>
        )}
        {canReport && (
          <LoginRedirect reason="report-model">
            <Menu.Item icon={<IconFlag size={14} stroke={1.5} />} onClick={handleReportClick}>
              Report
            </Menu.Item>
          </LoginRedirect>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
