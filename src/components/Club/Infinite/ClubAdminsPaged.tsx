import {
  ActionIcon,
  Alert,
  Box,
  Center,
  Code,
  CopyButton,
  Group,
  Loader,
  LoadingOverlay,
  Pagination,
  Table,
  Text,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { isEqual } from 'lodash-es';
import React, { useEffect, useState } from 'react';
import { useMutateClubAdmin, useQueryClubAdmins } from '~/components/Club/club.utils';
import { GetPagedClubAdminInviteSchema } from '~/server/schema/clubAdmin.schema';
import { IconTrash } from '@tabler/icons-react';
import { formatDate } from '../../../utils/date-helpers';
import { getDisplayName } from '../../../utils/string-helpers';
import { IconPencil } from '@tabler/icons-react';
import { dialogStore } from '../../Dialog/dialogStore';
import { openConfirmModal } from '@mantine/modals';
import { showSuccessNotification } from '../../../utils/notifications';
import { UserAvatar } from '../../UserAvatar/UserAvatar';
import { ClubAdminUpdateModal } from '../ClubAdminUpsertForm';
import { ClubAdmin } from '../../../types/router';

export function ClubAdminsPaged({ clubId }: Props) {
  // TODO.clubs: Add some custom filters for admins
  const [filters, setFilters] = useState<Omit<GetPagedClubAdminInviteSchema, 'limit' | 'clubId'>>({
    page: 1,
  });

  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);

  const { admins, pagination, isLoading, isRefetching } = useQueryClubAdmins(
    clubId,
    debouncedFilters
  );

  const { deleteAdmin, deletingAdmin } = useMutateClubAdmin();

  //#region [useEffect] cancel debounced filters
  useEffect(() => {
    if (isEqual(filters, debouncedFilters)) cancel();
  }, [cancel, debouncedFilters, filters]);
  //#endregion

  const onRemoveAdmin = (clubAdmin: ClubAdmin) => {
    openConfirmModal({
      title: 'Remove Club Admin',
      children: <Text size="sm">Are you sure you want to remove this admin?</Text>,
      centered: true,
      labels: { confirm: 'Remove', cancel: "No, don't remove it" },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        await deleteAdmin({ userId: clubAdmin.user.id, clubId });
        showSuccessNotification({
          title: 'Admin removed',
          message: 'The admin has been removed.',
        });
      },
    });
  };

  return (
    <>
      {isLoading ? (
        <Center p="xl">
          <Loader size="xl" />
        </Center>
      ) : !!admins.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
          <Table>
            <thead>
              <tr>
                <th>User</th>
                <th>Admin since</th>
                <th>Permissions</th>
                <th>&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {admins.map((admin) => {
                return (
                  <tr key={admin.user.id}>
                    <td>
                      <UserAvatar withUsername user={admin.user} />
                    </td>
                    <td>{formatDate(admin.createdAt)}</td>
                    <td style={{ maxWidth: 300 }}>
                      <Text>{admin.permissions.map((p) => getDisplayName(p)).join(', ')}</Text>
                    </td>
                    <td>
                      <Group position="right">
                        <ActionIcon
                          variant="transparent"
                          aria-label="Update invite"
                          onClick={() => {
                            dialogStore.trigger({
                              component: ClubAdminUpdateModal,
                              props: {
                                clubAdmin: admin,
                              },
                            });
                          }}
                        >
                          <IconPencil />
                        </ActionIcon>
                        <ActionIcon
                          variant="transparent"
                          aria-label="Delete invite"
                          loading={deletingAdmin}
                          onClick={() => {
                            onRemoveAdmin(admin);
                          }}
                        >
                          <IconTrash />
                        </ActionIcon>
                      </Group>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {pagination && pagination.totalPages > 1 && (
              <Group position="apart">
                <Text>Total {pagination.totalItems.toLocaleString()} items</Text>
                <Pagination
                  page={filters.page}
                  onChange={(page) => setFilters((curr) => ({ ...curr, page }))}
                  total={pagination.totalPages}
                />
              </Group>
            )}
          </Table>
        </div>
      ) : (
        <Alert title="No admins" color="gray">
          There are no active admins on this club.
        </Alert>
      )}
    </>
  );
}

type Props = { clubId: number };
