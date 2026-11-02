import { ActionIcon, Menu, Text } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconDotsVertical, IconTrash } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { ReportMenuItem } from '~/components/MenuItems/ReportMenuItem';
import { STORYLINES_URL } from '~/components/Storyline/storyline-routes';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * A chapter is reported as its post or image; this reports the storyline itself (its title). Its
 * owner and moderators delete it from here. The server has the last word on a delete (paid
 * continuations still settling, an open appeal) and its refusal is shown as is.
 */
export function StorylineContextMenu({
  storyline,
  isOwner,
}: {
  storyline: { id: number; title: string; tosViolation: boolean };
  isOwner: boolean;
}) {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const utils = trpc.useUtils();
  const remove = trpc.storyline.delete.useMutation({
    onSuccess: async () => {
      await router.push(STORYLINES_URL);
      await utils.storyline.getInfinite.invalidate();
    },
    onError: (error) =>
      showErrorNotification({
        title: "Couldn't delete the storyline",
        error: new Error(error.message),
      }),
  });

  const isModerator = !!currentUser?.isModerator;
  // A taken-down storyline is kept for moderation, so its owner is not offered what the server
  // would refuse.
  const canDelete = isModerator || (isOwner && !storyline.tosViolation);
  if (isOwner && !canDelete) return null;

  const confirmDelete = () =>
    openConfirmModal({
      title: 'Delete storyline',
      children: (
        <Text size="sm">
          Delete <strong>{storyline.title}</strong>? Every chapter&apos;s post stays published on
          its own; the storyline, its chapter order and its comments are gone for good.
        </Text>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => remove.mutate({ id: storyline.id }),
    });

  return (
    <Menu withinPortal withArrow position="bottom-end">
      <Menu.Target>
        <ActionIcon
          variant="default"
          size={50}
          radius="md"
          aria-label="More options"
          className="shrink-0"
          loading={remove.isPending}
        >
          <IconDotsVertical size={20} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {!isOwner && (
          <ReportMenuItem
            label="Report storyline"
            onReport={() =>
              openReportModal({ entityType: ReportEntity.Storyline, entityId: storyline.id })
            }
          />
        )}
        {canDelete && (
          <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={confirmDelete}>
            Delete storyline
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
