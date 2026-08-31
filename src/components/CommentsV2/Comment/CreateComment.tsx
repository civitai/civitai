import { Alert, Center, Group, Menu, Text } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import router from 'next/router';
import { CommentForm } from './CommentForm';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SimpleUser } from '~/server/selectors/user.selector';
import { useCommentsContext } from '~/components/CommentsV2/CommentsProvider';
import { IconBell, IconBellOff, IconDotsVertical, IconLock } from '@tabler/icons-react';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useState } from 'react';
import { trpc } from '~/utils/trpc';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';

type CreateCommentProps = {
  onCancel?: () => void;
  autoFocus?: boolean;
  replyToCommentId?: number;
  className?: string;
  borderless?: boolean;
};

export function CreateComment({
  onCancel,
  autoFocus,
  replyToCommentId,
  className,
  borderless,
}: CreateCommentProps) {
  const currentUser = useCurrentUser();
  const { isLocked, isMuted, isReadonly, forceLocked, entityType, entityId } = useCommentsContext();
  const sectionMute = useSectionMute({ entityType, entityId, enabled: !replyToCommentId });

  if (!currentUser)
    return (
      <Alert>
        <Group align="center" justify="center" gap="xs">
          <Text size="sm">
            You must{' '}
            <Text
              c="blue.4"
              component={Link}
              href={`/login?returnUrl=${router.asPath}`}
              rel="nofollow"
              inline
            >
              sign in
            </Text>{' '}
            to add a comment
          </Text>
        </Group>
      </Alert>
    );

  if (forceLocked) {
    return (
      <Alert color="yellow">
        <Center>You do not have permissions to add comments.</Center>
      </Alert>
    );
  }

  if (isLocked || isMuted || isReadonly)
    return (
      <Alert color="yellow" icon={<IconLock />}>
        <Center>
          {isMuted
            ? 'You cannot add comments because you have been muted'
            : isLocked
            ? 'This thread has been locked'
            : 'Civitai is currently in read-only mode'}
        </Center>
      </Alert>
    );

  return (
    <Group align="flex-start" wrap="nowrap" gap="sm" className={className}>
      <UserAvatar user={currentUser} size={replyToCommentId ? 'sm' : 'md'} />
      <CommentForm
        onCancel={onCancel}
        autoFocus={autoFocus}
        replyToCommentId={replyToCommentId}
        borderless={borderless}
      />
      {!replyToCommentId && sectionMute.control}
    </Group>
  );
}

/**
 * The whole-section control, which mutes the entity's root thread rather than a conversation under
 * one comment. Only rendered on the top-level composer: on a reply box the enclosing comment's own
 * menu is the right place, and two mute controls a few pixels apart would mean different things.
 */
function useSectionMute({
  entityType,
  entityId,
  enabled,
}: {
  entityType: ReturnType<typeof useCommentsContext>['entityType'];
  entityId: number;
  enabled: boolean;
}) {
  const queryUtils = trpc.useUtils();
  const [opened, setOpened] = useState(false);

  // Fetched on menu open only, so a page of comments costs no extra requests.
  const { data } = trpc.commentv2.getSectionMuted.useQuery(
    { entityType, entityId },
    { enabled: enabled && opened }
  );

  const toggle = trpc.commentv2.toggleSectionMute.useMutation({
    onSuccess(result) {
      queryUtils.commentv2.getSectionMuted.setData(
        { entityType, entityId },
        { muted: result.muted }
      );
      showSuccessNotification({
        message: result.muted
          ? "You won't be notified about new comments here"
          : "You'll be notified about new comments here again",
      });
    },
    onError(error) {
      showErrorNotification({
        title: 'Unable to update notifications',
        error: new Error(error.message),
      });
    },
  });

  const control = (
    <Menu position="bottom-end" withinPortal opened={opened} onChange={setOpened}>
      <Menu.Target>
        <LegacyActionIcon size="sm" variant="subtle" aria-label="Comment notification settings">
          <IconDotsVertical size={16} />
        </LegacyActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Item
          disabled={!data || toggle.isPending}
          leftSection={
            data?.muted ? (
              <IconBell size={14} stroke={1.5} />
            ) : (
              <IconBellOff size={14} stroke={1.5} />
            )
          }
          onClick={() => toggle.mutate({ entityType, entityId })}
        >
          {data?.muted ? 'Unmute this discussion' : 'Mute this discussion'}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );

  return { control };
}
