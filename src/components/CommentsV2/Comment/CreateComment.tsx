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
import { sectionMuteSchema, type SectionMuteInput } from '~/server/schema/commentv2.schema';
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
  // `comicChapter` threads are keyed by (project, position) rather than a single column, and a
  // `comment` section is muted through the comment's own menu — the section endpoint accepts
  // neither, so do not render a control that could only fail.
  const sectionMuteTarget = sectionMuteSchema.safeParse({ entityType, entityId });
  const sectionMute = useSectionMute({
    target: sectionMuteTarget.success ? sectionMuteTarget.data : undefined,
    enabled: !replyToCommentId,
  });

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

  // Not being able to POST is not a reason to lose the notification control. A site-muted account
  // still receives replies to comments it made before the restriction, and the router uses
  // `protectedProcedure` rather than `guardedProcedure` precisely so that account can silence them —
  // hiding it here would have made that choice unreachable. Read-only is the exception: the write
  // would fail, so the control comes off with everything else.
  if (isLocked || isMuted)
    return (
      <Group align="center" justify="space-between" wrap="nowrap" gap="sm">
        <Alert color="yellow" icon={<IconLock />} style={{ flex: 1 }}>
          <Center>
            {isMuted
              ? 'You cannot add comments because you have been muted'
              : 'This thread has been locked'}
          </Center>
        </Alert>
        {!replyToCommentId && sectionMute.control}
      </Group>
    );

  if (isReadonly)
    return (
      <Alert color="yellow" icon={<IconLock />}>
        <Center>Civitai is currently in read-only mode</Center>
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
function useSectionMute({ target, enabled }: { target?: SectionMuteInput; enabled: boolean }) {
  const queryUtils = trpc.useUtils();
  const [opened, setOpened] = useState(false);

  // Fetched on menu open only, so a page of comments costs no extra requests.
  const { data } = trpc.commentv2.getSectionMuted.useQuery(target ?? ({} as SectionMuteInput), {
    enabled: !!target && enabled && opened,
  });

  const toggle = trpc.commentv2.toggleSectionMute.useMutation({
    onSuccess(result) {
      if (!target) return;
      queryUtils.commentv2.getSectionMuted.setData(target, {
        muted: result.muted,
        hasThread: result.threadId !== null,
      });
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
        {/*
          Centred on the INPUT, not on the composer. The composer is two rows — the field, then the
          emoji picker and Cancel/Comment — so centring against the whole block drops the kebab into
          the gap between them. `self-start` with the avatar's own height puts it level with the
          field, the same way the avatar is. 38px is Mantine's `md` Avatar, which is the size
          `UserAvatar` gets here: this control only renders when `replyToCommentId` is absent, which
          is exactly when that avatar is `md`.
        */}
        <div className="flex h-[38px] shrink-0 items-center self-start">
          <LegacyActionIcon size="sm" variant="subtle" aria-label="Comment notification settings">
            <IconDotsVertical size={16} />
          </LegacyActionIcon>
        </div>
      </Menu.Target>
      <Menu.Dropdown>
        {/*
          Nothing to mute until the first comment creates the thread. Disabled rather than hidden,
          and it says why: firing the mutation there writes nothing and would report success.
        */}
        <Menu.Item
          disabled={!data || !data.hasThread || toggle.isPending}
          leftSection={
            data?.muted ? (
              <IconBell size={14} stroke={1.5} />
            ) : (
              <IconBellOff size={14} stroke={1.5} />
            )
          }
          onClick={() => target && toggle.mutate(target)}
        >
          {!data
            ? 'Mute this discussion'
            : !data.hasThread
            ? 'No comments to mute yet'
            : data.muted
            ? 'Unmute this discussion'
            : 'Mute this discussion'}
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );

  return { control: target ? control : null };
}
