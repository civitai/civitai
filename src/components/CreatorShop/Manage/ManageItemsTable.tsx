import { Paper, Table } from '@mantine/core';
import type { CreatorShopManageItem } from '~/components/CreatorShop/creator-shop.util';
import { useMutateCreatorShop } from '~/components/CreatorShop/creator-shop.util';
import { useManageColumns } from '~/components/CreatorShop/Manage/manage.columns';

export function ManageItemsTable({
  items,
  archiveItem,
  unarchiveItem,
}: {
  items: CreatorShopManageItem[];
  archiveItem: ReturnType<typeof useMutateCreatorShop>['archiveItem'];
  unarchiveItem: ReturnType<typeof useMutateCreatorShop>['unarchiveItem'];
}) {
  const columns = useManageColumns(archiveItem, unarchiveItem);

  return (
    <Paper withBorder radius="md" className="overflow-hidden">
      <Table.ScrollContainer minWidth={820}>
        <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover layout="fixed">
          <Table.Thead className="bg-gray-1 dark:bg-dark-6">
            <Table.Tr>
              {columns.map((col) => (
                <Table.Th key={col.key} w={col.width} ta={col.align}>
                  {col.header}
                </Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {items.map((item) => (
              <Table.Tr key={item.id}>
                {columns.map((col) => (
                  <Table.Td key={col.key} ta={col.align}>
                    {col.render(item)}
                  </Table.Td>
                ))}
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Paper>
  );
}
