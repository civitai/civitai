import {
  ActionIcon,
  Alert,
  Center,
  Group,
  Loader,
  LoadingOverlay,
  Pagination,
  Table,
  Text,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { isEqual } from 'lodash-es';
import React, { useEffect, useState } from 'react';
import { useQueryClubAdminInvites } from '~/components/Club/club.utils';
import { trpc } from '~/utils/trpc';
import { GetPagedClubAdminInviteSchema } from '~/server/schema/clubAdmin.schema';
import { IconTrash } from '@tabler/icons-react';
import { formatDate } from '../../../utils/date-helpers';
import { getDisplayName } from '../../../utils/string-helpers';
import { IconPencil } from '@tabler/icons-react';
import { dialogStore } from '../../Dialog/dialogStore';
import { ClubAdminInviteUpsertModal } from '../ClubAdminInviteUpsertForm';

export function ClubAdminInvitesPaged({ clubId }: Props) {
  const utils = trpc.useContext();

  // TODO.clubs: Add some custom filters for resources. Model type and perhaps a query of sorts.
  const [filters, setFilters] = useState<Omit<GetPagedClubAdminInviteSchema, 'limit' | 'clubId'>>({
    page: 1,
  });

  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);

  const { invites, pagination, isLoading, isRefetching } = useQueryClubAdminInvites(
    clubId,
    debouncedFilters
  );

  //#region [useEffect] cancel debounced filters
  useEffect(() => {
    if (isEqual(filters, debouncedFilters)) cancel();
  }, [cancel, debouncedFilters, filters]);
  //#endregion

  return (
    <>
      {isLoading ? (
        <Center p="xl">
          <Loader size="xl" />
        </Center>
      ) : !!invites.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />
          <Table>
            <thead>
              <tr>
                <th>Created At</th>
                <th>Expires At</th>
                <th>Permissions</th>
                <th>&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {invites.map((invite) => {
                return (
                  <tr key={invite.id}>
                    <td>{formatDate(invite.createdAt)}</td>
                    <td>{invite.expiresAt ? formatDate(invite.expiresAt) : '-'}</td>
                    <td>{invite.permissions.map((p) => getDisplayName(p)).join(', ')}</td>
                    <td>
                      <Group>
                        <ActionIcon
                          variant="transparent"
                          aria-label="Update invite"
                          onClick={() => {
                            dialogStore.trigger({
                              component: ClubAdminInviteUpsertModal,
                              props: {
                                clubId,
                                clubAdminInvite: invite,
                              },
                            });
                          }}
                        >
                          <IconPencil />
                        </ActionIcon>
                        <ActionIcon
                          variant="transparent"
                          aria-label="Delete invite"
                          onClick={() => {
                            console.log('todo');
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
        <Alert title="No admin invites" color="gray">
          There are no admin invites for this club.
        </Alert>
      )}
    </>
  );
}

type Props = { clubId: number };
