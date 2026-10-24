import { ActionIcon, Menu } from '@mantine/core';
import { IconDotsVertical } from '@tabler/icons-react';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { ReportMenuItem } from '~/components/MenuItems/ReportMenuItem';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ReportEntity } from '~/shared/utils/report-helpers';

/** A chapter is reported as its post or image; this reports the storyline itself (its title). */
export function StorylineContextMenu({
  storylineId,
  isOwner,
}: {
  storylineId: number;
  isOwner: boolean;
}) {
  const currentUser = useCurrentUser();
  if (isOwner && !currentUser?.isModerator) return null;

  return (
    <Menu withinPortal withArrow position="bottom-end">
      <Menu.Target>
        <ActionIcon
          variant="default"
          size={50}
          radius="md"
          aria-label="More options"
          className="shrink-0"
        >
          <IconDotsVertical size={20} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <ReportMenuItem
          label="Report storyline"
          onReport={() =>
            openReportModal({ entityType: ReportEntity.Storyline, entityId: storylineId })
          }
        />
      </Menu.Dropdown>
    </Menu>
  );
}
