import type { ActionIconProps, MenuItemProps, MenuProps } from '@mantine/core';
import { Menu } from '@mantine/core';
import { IconBell, IconBellOff } from '@tabler/icons-react';
import { ActionIconDotsVertical } from '~/components/Cards/components/ActionIconDotsVertical';
import { openReportModal } from '~/components/Dialog/triggers/report';
import { ReportMenuItem } from '~/components/MenuItems/ReportMenuItem';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ReportEntity } from '~/server/schema/report.schema';
import { ComicEngagementType } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

type Props = MenuProps & {
  comic: {
    id: number;
    user: { id: number };
  };
  buttonProps?: ActionIconProps;
};

export function ComicCardContextMenu({ comic, buttonProps, ...menuProps }: Props) {
  const currentUser = useCurrentUser();
  const isOwner = currentUser?.id === comic.user.id;
  const isModerator = currentUser?.isModerator ?? false;

  const { data: engagement } = trpc.comics.getComicEngagement.useQuery(
    { projectId: comic.id },
    { enabled: !!currentUser }
  );
  const utils = trpc.useUtils();
  const toggleEngagement = trpc.comics.toggleComicEngagement.useMutation({
    onSuccess: () => {
      utils.comics.getComicEngagement.invalidate({ projectId: comic.id });
    },
  });
  const isFollowing = engagement === ComicEngagementType.Notify;

  const menuItems: React.ReactElement<MenuItemProps>[] = [
    currentUser ? (
      <Menu.Item
        key="follow"
        leftSection={
          isFollowing ? (
            <IconBellOff size={14} stroke={1.5} />
          ) : (
            <IconBell size={14} stroke={1.5} />
          )
        }
        onClick={(e: React.MouseEvent) => {
          e.preventDefault();
          e.stopPropagation();
          toggleEngagement.mutate({
            projectId: comic.id,
            type: ComicEngagementType.Notify,
          });
        }}
        disabled={toggleEngagement.isPending}
      >
        {isFollowing ? 'Unfollow' : 'Follow'}
      </Menu.Item>
    ) : null,
    !isOwner || isModerator ? (
      <ReportMenuItem
        key="report"
        label="Report comic"
        loginReason="report-comic"
        onReport={() =>
          openReportModal({ entityType: ReportEntity.ComicProject, entityId: comic.id })
        }
      />
    ) : null,
  ].filter(isDefined);

  if (!menuItems.length) return null;

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
      <Menu.Dropdown>{menuItems}</Menu.Dropdown>
    </Menu>
  );
}
