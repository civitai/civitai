import { Text } from '@mantine/core';
import { Menu } from '~/components/MantineOverlays';
import { useClipboard } from '@mantine/hooks';
import { closeAllModals, openConfirmModal } from '@mantine/modals';
import {
  IconBell,
  IconBellOff,
  IconDotsVertical,
  IconEdit,
  IconEye,
  IconEyeOff,
  IconFlag,
  IconId,
  IconLink,
  IconLock,
  IconLockOpen,
  IconPinned,
  IconPinnedOff,
  IconShieldOff,
  IconTrash,
} from '@tabler/icons-react';
import { useState } from 'react';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { BlockUserButton } from '~/components/HideUserButton/BlockUserButton';
import { HideUserButton } from '~/components/HideUserButton/HideUserButton';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { isViewer } from '~/utils/is-viewer';
import { showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { useCommentSection } from './CommentSectionContext';
import type { CommentV3Comment } from './types';
import { useCommentMutations } from './useCommentMutations';

export function useCommentAbilities(comment: CommentV3Comment, lockedAbove: boolean) {
  const { ownerId, isMuted, forceLocked } = useCommentSection();
  const currentUser = useCurrentUser();
  const isOwner = isViewer(currentUser, comment.user?.id);
  const isMod = !!currentUser?.isModerator;
  const isResourceOwner = isViewer(currentUser, ownerId);
  return {
    isMod,
    delete: isOwner || isMod,
    edit: (isOwner || isMod) && ((!lockedAbove && !isMuted) || isMod),
    reply:
      !!currentUser &&
      !lockedAbove &&
      !comment.locked &&
      !isMuted &&
      !forceLocked &&
      !comment.hidden,
    hide: isResourceOwner || isMod,
    pin: isResourceOwner || isMod,
    report: !isOwner,
  };
}

/** A comment's actions menu. Renders nothing for a deleted comment's placeholder. */
export function CommentMenu({
  comment,
  lockedAbove,
  onEdit,
}: {
  comment: CommentV3Comment;
  lockedAbove: boolean;
  onEdit: () => void;
}) {
  const { entityType } = useCommentSection();
  const currentUser = useCurrentUser();
  const mutations = useCommentMutations();
  const clipboard = useClipboard();
  const can = useCommentAbilities(comment, lockedAbove);
  const [opened, setOpened] = useState(false);

  // Fetched only while the menu is open: one query per comment on every page would cost more.
  const { data: commentMute } = trpc.commentv3.getCommentMuted.useQuery(
    { commentId: comment.id },
    { enabled: opened && !!currentUser }
  );

  const author = comment.user;
  if (!author) return null;

  const confirmDelete = () =>
    openConfirmModal({
      title: 'Delete comment',
      children: (
        <Text size="sm">
          Are you sure you want to delete this comment? This action is destructive and cannot be
          reverted.
        </Text>
      ),
      centered: true,
      labels: { confirm: 'Delete comment', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => void mutations.delete(comment).catch(() => null),
    });
  const confirmTos = () =>
    openConfirmModal({
      title: 'Remove as ToS violation',
      children: (
        <Text size="sm">
          This flags the comment as a Terms of Service violation, actions any matching reports and
          notifies the author. Are you sure?
        </Text>
      ),
      centered: true,
      labels: { confirm: 'Remove as ToS violation', cancel: 'Cancel' },
      confirmProps: { color: 'red', loading: mutations.settingTos },
      closeOnConfirm: false,
      onConfirm: () =>
        mutations
          .removeAsTos(comment)
          .catch(() => null)
          .finally(() => closeAllModals()),
    });

  return (
    <Menu position="bottom-end" withinPortal opened={opened} onChange={setOpened}>
      <Menu.Target>
        <LegacyActionIcon size="xs" variant="subtle" aria-label="Comment options">
          <IconDotsVertical size={14} />
        </LegacyActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {can.delete && (
          <Menu.Item
            leftSection={<IconTrash size={14} stroke={1.5} />}
            color="red"
            onClick={confirmDelete}
          >
            Delete comment
          </Menu.Item>
        )}
        {can.edit && (
          <Menu.Item leftSection={<IconEdit size={14} stroke={1.5} />} onClick={onEdit}>
            Edit comment
          </Menu.Item>
        )}
        {can.hide && (
          <Menu.Item
            leftSection={
              comment.hidden ? (
                <IconEye size={14} stroke={1.5} />
              ) : (
                <IconEyeOff size={14} stroke={1.5} />
              )
            }
            onClick={() => void mutations.toggleHide(comment).catch(() => null)}
          >
            {comment.hidden ? 'Unhide comment' : 'Hide comment'}
          </Menu.Item>
        )}
        {can.pin && !comment.hidden && (
          <Menu.Item
            leftSection={
              comment.pinnedAt ? (
                <IconPinnedOff size={14} stroke={1.5} />
              ) : (
                <IconPinned size={14} stroke={1.5} />
              )
            }
            onClick={() => void mutations.togglePin(comment).catch(() => null)}
          >
            {comment.pinnedAt ? 'Unpin comment' : 'Pin comment'}
          </Menu.Item>
        )}
        {can.isMod && entityType === 'model' && (
          <Menu.Item
            leftSection={
              comment.locked ? (
                <IconLockOpen size={14} stroke={1.5} />
              ) : (
                <IconLock size={14} stroke={1.5} />
              )
            }
            onClick={() => void mutations.toggleLock(comment).catch(() => null)}
          >
            {comment.locked ? 'Unlock replies' : 'Lock replies'}
          </Menu.Item>
        )}
        <HideUserButton as="menu-item" userId={author.id} />
        <BlockUserButton userId={author.id} as="menu-item" />
        {can.report && (
          <LoginRedirect reason="report-model">
            <Menu.Item
              leftSection={<IconFlag size={14} stroke={1.5} />}
              onClick={() =>
                openReportModal({
                  entityType: ReportEntity.CommentV3,
                  entityId: comment.id,
                })
              }
            >
              Report
            </Menu.Item>
          </LoginRedirect>
        )}
        {currentUser && (
          <Menu.Item
            leftSection={
              commentMute?.muted ? (
                <IconBell size={14} stroke={1.5} />
              ) : (
                <IconBellOff size={14} stroke={1.5} />
              )
            }
            // The toggle flips from the stored state, so it waits for that state to load.
            disabled={
              !commentMute ||
              commentMute.viaAncestor ||
              mutations.togglingMute ||
              !commentMute.canMute
            }
            onClick={() => void mutations.toggleMute(comment).catch(() => null)}
          >
            {commentMute?.viaAncestor
              ? 'Muted with a comment above'
              : commentMute && !commentMute.canMute
              ? 'No replies to mute yet'
              : commentMute?.muted
              ? 'Unmute replies to this comment'
              : 'Mute replies to this comment'}
          </Menu.Item>
        )}
        <Menu.Item
          leftSection={<IconLink size={14} stroke={1.5} />}
          onClick={() => {
            // Through the permalink, so the copy carries none of this page's link parameters.
            clipboard.copy(`${window.location.origin}/comments/${comment.id}`);
            showSuccessNotification({ message: 'Comment link copied to clipboard' });
          }}
        >
          Copy link
        </Menu.Item>
        {can.isMod && (
          <Menu.Item
            leftSection={<IconId size={14} stroke={1.5} />}
            onClick={() => {
              clipboard.copy(String(comment.id));
              showSuccessNotification({ message: 'Comment ID copied to clipboard' });
            }}
          >
            Copy comment ID
          </Menu.Item>
        )}
        {can.isMod && !comment.tosViolation && (
          <Menu.Item
            color="red"
            leftSection={<IconShieldOff size={14} stroke={1.5} />}
            onClick={confirmTos}
          >
            Remove as ToS violation
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
