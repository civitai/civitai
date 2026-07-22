import { ActionIcon, Badge, Group, Menu, Stack, Text } from '@mantine/core';
import { openConfirmModal } from '@mantine/modals';
import { IconArchive, IconArchiveOff, IconDots, IconEdit, IconTrash } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { CreatorShopSubmitModal } from '~/components/CreatorShop/CreatorShopSubmitModal';
import type { CreatorShopManageItem } from '~/components/CreatorShop/creator-shop.util';
import { useMutateCreatorShop } from '~/components/CreatorShop/creator-shop.util';
import { CosmeticThumb } from '~/components/CreatorShop/CosmeticThumb';
import { statusMeta } from '~/components/CreatorShop/Manage/manage.constants';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { CosmeticShopItemStatus } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';

type ArchiveMutation = ReturnType<typeof useMutateCreatorShop>['archiveItem'];
type UnarchiveMutation = ReturnType<typeof useMutateCreatorShop>['unarchiveItem'];
type DeleteMutation = ReturnType<typeof useMutateCreatorShop>['deleteItem'];

// A column owns both its header cell and how it renders a row cell, so adding /
// reordering columns is a localized change to this array.
export type ManageColumn = {
  key: string;
  header: ReactNode;
  width?: number;
  align?: 'right';
  render: (item: CreatorShopManageItem) => ReactNode;
};

function ItemCell({ item }: { item: CreatorShopManageItem }) {
  return (
    <Group gap="sm" wrap="nowrap" align="center">
      <CosmeticThumb data={item.cosmetic.data} name={item.title} bare />
      <Stack gap={0} className="min-w-0">
        <Text size="sm" fw={600} lineClamp={1}>
          {item.title}
        </Text>
        <Text size="xs" c="dimmed">
          {getDisplayName(item.cosmetic.type)}
        </Text>
        {item.rejectionReason &&
          (item.status === CosmeticShopItemStatus.Rejected ||
            item.status === CosmeticShopItemStatus.RequestedChanges) && (
            <Text
              size="xs"
              c={item.status === CosmeticShopItemStatus.Rejected ? 'red' : 'orange'}
              mt={2}
              lineClamp={2}
            >
              {item.status === CosmeticShopItemStatus.Rejected ? 'Rejected' : 'Changes requested'}:{' '}
              {item.rejectionReason}
            </Text>
          )}
      </Stack>
    </Group>
  );
}

function ItemActionsMenu({
  item,
  archiveItem,
  unarchiveItem,
  deleteItem,
}: {
  item: CreatorShopManageItem;
  archiveItem: ArchiveMutation;
  unarchiveItem: UnarchiveMutation;
  deleteItem: DeleteMutation;
}) {
  const currentUser = useCurrentUser();
  const isArchived = item.status === CosmeticShopItemStatus.Archived;

  const confirmDelete = () =>
    openConfirmModal({
      title: 'Delete shop item',
      children: (
        <Stack gap="xs">
          <Text size="sm">
            Permanently delete <strong>{item.title}</strong>? This can&apos;t be undone — archive it
            instead if you might want it back.
          </Text>
          {item.purchases > 0 && (
            <Text size="sm" c="red">
              This item has <strong>{numberWithCommas(item.purchases)}</strong> sale
              {item.purchases === 1 ? '' : 's'}. Its purchase records and sales totals will be
              permanently lost. Buyers keep the cosmetics they purchased.
            </Text>
          )}
        </Stack>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      centered: true,
      onConfirm: () => deleteItem.mutate({ id: item.id }),
    });

  return (
    <Menu withinPortal position="bottom-end">
      <Menu.Target>
        <ActionIcon variant="subtle" color="gray">
          <IconDots size={18} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {isArchived ? (
          <Menu.Item
            leftSection={<IconArchiveOff size={16} />}
            disabled={unarchiveItem.isPending}
            onClick={() => unarchiveItem.mutate({ id: item.id })}
          >
            Restore
          </Menu.Item>
        ) : (
          <>
            <Menu.Item
              leftSection={<IconEdit size={16} />}
              // Rejected is terminal — nothing more can be changed.
              disabled={item.status === CosmeticShopItemStatus.Rejected}
              onClick={() =>
                dialogStore.trigger({ component: CreatorShopSubmitModal, props: { item } })
              }
            >
              {item.status === CosmeticShopItemStatus.RequestedChanges ? 'Edit & resubmit' : 'Edit'}
            </Menu.Item>
            <Menu.Item
              leftSection={<IconArchive size={16} />}
              disabled={archiveItem.isPending}
              onClick={() => archiveItem.mutate({ id: item.id })}
            >
              Archive
            </Menu.Item>
          </>
        )}
        {/* Deleting wipes purchase records — moderator-only; creators archive. */}
        {currentUser?.isModerator && (
          <Menu.Item
            color="red"
            leftSection={<IconTrash size={16} />}
            disabled={deleteItem.isPending}
            onClick={confirmDelete}
          >
            Delete
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}

export function useManageColumns(
  archiveItem: ArchiveMutation,
  unarchiveItem: UnarchiveMutation,
  deleteItem: DeleteMutation
): ManageColumn[] {
  return useMemo(
    () => [
      { key: 'item', header: 'Item', render: (item) => <ItemCell item={item} /> },
      {
        key: 'type',
        header: 'Type',
        width: 110,
        render: () => (
          <Text size="sm" c="dimmed">
            Cosmetic
          </Text>
        ),
      },
      {
        key: 'price',
        header: 'Price',
        width: 120,
        render: (item) => (
          <Text size="sm" className="whitespace-nowrap">
            {numberWithCommas(item.unitAmount)} Buzz
          </Text>
        ),
      },
      {
        key: 'status',
        header: 'Status',
        width: 170,
        render: (item) => {
          const meta = statusMeta[item.status];
          return (
            <Badge color={meta.color} variant="dot" style={{ maxWidth: 'none' }}>
              {meta.label}
            </Badge>
          );
        },
      },
      {
        key: 'sales',
        header: 'Sales',
        width: 80,
        align: 'right',
        render: (item) => item.purchases,
      },
      {
        key: 'updated',
        header: 'Updated',
        width: 120,
        render: (item) => (
          <Text size="xs" c="dimmed" className="whitespace-nowrap">
            {formatDate(item.createdAt)}
          </Text>
        ),
      },
      {
        key: 'actions',
        header: '',
        width: 56,
        align: 'right',
        render: (item) => (
          <ItemActionsMenu
            item={item}
            archiveItem={archiveItem}
            unarchiveItem={unarchiveItem}
            deleteItem={deleteItem}
          />
        ),
      },
    ],
    [archiveItem, unarchiveItem, deleteItem]
  );
}
