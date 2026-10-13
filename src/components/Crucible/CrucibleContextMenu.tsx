import type { ActionIconProps, MenuProps } from '@mantine/core';
import { Loader, Menu } from '@mantine/core';
import { IconLock, IconLockOpen } from '@tabler/icons-react';
import { ActionIconDotsVertical } from '~/components/Cards/components/ActionIconDotsVertical';
import { ToggleLockComments } from '~/components/CommentsV2/ToggleLockComments';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { ReportMenuItem } from '~/components/MenuItems/ReportMenuItem';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ReportEntity } from '~/shared/utils/report-helpers';

type Props = MenuProps & {
  crucible: { id: number; userId: number };
  buttonProps?: ActionIconProps;
  /** Moderators only, and only where the discussion is shown: each lock item reads its thread on open. */
  withCommentsLock?: boolean;
};

export function CrucibleContextMenu({
  crucible,
  buttonProps,
  withCommentsLock,
  ...menuProps
}: Props) {
  const currentUser = useCurrentUser();
  const isOwner = currentUser?.id === crucible.userId;
  const isModerator = !!currentUser?.isModerator;
  const canLockComments = !!withCommentsLock && isModerator;
  const canReport = !isOwner || isModerator;
  if (!canReport && !canLockComments) return null;

  return (
    <Menu withinPortal withArrow {...menuProps}>
      <Menu.Target>
        <ActionIconDotsVertical
          onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          {...buttonProps}
        />
      </Menu.Target>
      <Menu.Dropdown>
        {canReport && (
          <ReportMenuItem
            label="Report crucible"
            onReport={() =>
              openReportModal({ entityType: ReportEntity.Crucible, entityId: crucible.id })
            }
          />
        )}
        {canLockComments && (
          <ToggleLockComments entityId={crucible.id} entityType="crucible">
            {({ toggle, locked, isLoading }) => (
              <Menu.Item
                leftSection={
                  isLoading ? (
                    <Loader size={14} />
                  ) : locked ? (
                    <IconLockOpen size={14} stroke={1.5} />
                  ) : (
                    <IconLock size={14} stroke={1.5} />
                  )
                }
                onClick={toggle}
                closeMenuOnClick={false}
                disabled={isLoading}
              >
                {locked ? 'Unlock' : 'Lock'} Comments
              </Menu.Item>
            )}
          </ToggleLockComments>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}
