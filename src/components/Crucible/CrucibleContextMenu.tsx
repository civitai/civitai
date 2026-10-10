import type { ActionIconProps, MenuProps } from '@mantine/core';
import { Menu } from '@mantine/core';
import { ActionIconDotsVertical } from '~/components/Cards/components/ActionIconDotsVertical';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { ReportMenuItem } from '~/components/MenuItems/ReportMenuItem';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ReportEntity } from '~/shared/utils/report-helpers';

type Props = MenuProps & {
  crucible: { id: number; userId: number };
  buttonProps?: ActionIconProps;
};

export function CrucibleContextMenu({ crucible, buttonProps, ...menuProps }: Props) {
  const currentUser = useCurrentUser();
  const isOwner = currentUser?.id === crucible.userId;
  if (isOwner && !currentUser?.isModerator) return null;

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
        <ReportMenuItem
          label="Report crucible"
          onReport={() =>
            openReportModal({ entityType: ReportEntity.Crucible, entityId: crucible.id })
          }
        />
      </Menu.Dropdown>
    </Menu>
  );
}
