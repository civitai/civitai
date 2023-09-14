import { ActionIcon, ActionIconProps, Menu, MenuItemProps, MenuProps } from '@mantine/core';
import { closeAllModals, openConfirmModal } from '@mantine/modals';
import { IconDotsVertical, IconEdit, IconTrash } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { isDefined } from '~/utils/type-guards';
import { useMutateBounty } from './bounty.utils';
import { ReportMenuItem } from '../MenuItems/ReportMenuItem';

export function BountyContextMenu({
  bounty,
  buttonProps: { iconSize, ...buttonProps } = { iconSize: 16 },
  ...menuProps
}: Props) {
  const currentUser = useCurrentUser();
  const router = useRouter();
  const isModerator = currentUser?.isModerator ?? false;
  const isOwner = currentUser?.id === bounty.user?.id || isModerator;

  const { deleteBounty } = useMutateBounty({ bountyId: bounty.id });

  const menuItems: React.ReactElement<MenuItemProps>[] = [
    isOwner || isModerator ? (
      <Menu.Item
        key="delete"
        color="red"
        icon={<IconTrash size={14} stroke={1.5} />}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();

          openConfirmModal({
            title: 'Delete bounty',
            children:
              'Are you sure that you want to delete this bounty? This action is destructive and cannot be reverted.',
            centered: true,
            closeOnConfirm: false,
            labels: { cancel: 'No, keep it', confirm: 'Delete bounty' },
            confirmProps: { color: 'red' },
            onConfirm: async () => {
              try {
                await deleteBounty();
                closeAllModals();
                const atDetailsPage = router.pathname === '/bounties/[id]/[[...slug]]';
                if (atDetailsPage) await router.push('/bounties');
              } catch (error) {
                // Do nothing since the query event will show an error notification
              }
            },
          });
        }}
      >
        Delete
      </Menu.Item>
    ) : null,
    isOwner || isModerator ? (
      <Link key="edit" href={`/bounties/${bounty.id}/edit`} passHref>
        <Menu.Item component="a" icon={<IconEdit size={14} stroke={1.5} />}>
          Edit
        </Menu.Item>
      </Link>
    ) : null,
    // TODO.bounty: report bounty
    !isOwner || isModerator ? (
      <ReportMenuItem
        key="report"
        label="Report bounty"
        onReport={() => console.log('open report modal')}
      />
    ) : null,
  ].filter(isDefined);

  if (!menuItems.length) return null;

  return (
    <Menu {...menuProps}>
      <Menu.Target>
        <ActionIcon
          color="gray"
          radius="xl"
          variant="filled"
          {...buttonProps}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <IconDotsVertical size={iconSize} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>{menuItems}</Menu.Dropdown>
    </Menu>
  );
}

type Props = MenuProps & {
  bounty: {
    id: number;
    user: { id: number } | null;
  };
  buttonProps?: ActionIconProps & { iconSize?: number };
};
