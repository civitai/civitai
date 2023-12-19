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
import { useMutateClubAdmin, useQueryClubAdminInvites } from '~/components/Club/club.utils';
import { trpc } from '~/utils/trpc';
import { GetPagedClubAdminInviteSchema } from '~/server/schema/clubAdmin.schema';
import { IconTrash } from '@tabler/icons-react';
import { formatDate } from '../../../utils/date-helpers';
import { getDisplayName } from '../../../utils/string-helpers';
import { IconPencil } from '@tabler/icons-react';
import { dialogStore } from '../../Dialog/dialogStore';
import { ClubAdminInviteUpsertModal } from '../ClubAdminInviteUpsertForm';
import { openConfirmModal } from '@mantine/modals';
import { showSuccessNotification } from '../../../utils/notifications';
import { IconClipboard } from '@tabler/icons-react';
import { IconCheck } from '@tabler/icons-react';
import { env } from '../../../env/client.mjs';

export function ClubAdminInvitesPaged({ clubId }: Props) {
  // TODO.clubs: Add some custom filters for invites (?)
  const [filters, setFilters] = useState<Omit<GetPagedClubAdminInviteSchema, 'limit' | 'clubId'>>({
    page: 1,
  });

  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);

  const { invites, pagination, isLoading, isRefetching } = useQueryClubAdminInvites(
    clubId,
    debouncedFilters
  );

  const { deleteInvite, deletingInvite } = useMutateClubAdmin();

  //#region [useEffect] cancel debounced filters
  useEffect(() => {
    if (isEqual(filters, debouncedFilters)) cancel();
  }, [cancel, debouncedFilters, filters]);
  //#endregion

  const onDeleteInvite = (id: string) => {
    openConfirmModal({
      title: 'Delete Club Admin Invite',
      children: <Text size="sm">Are you sure you want to delete this invite?</Text>,
      centered: true,
      labels: { confirm: 'Delete Invite', cancel: "No, don't delete it" },
      confirmProps: { color: 'red' },
      onConfirm: async () => {
        await deleteInvite({ id, clubId });
        showSuccessNotification({
          title: 'Invite deleted',
          message: 'The invite has been deleted.',
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
                    <td style={{ maxWidth: 300 }}>
                      <Text>{invite.permissions.map((p) => getDisplayName(p)).join(', ')}</Text>
                    </td>
                    <td>
                      <Group position="right">
                        <CopyButton
                          value={`${env.NEXT_PUBLIC_BASE_URL}/clubs/invites/${invite.id}`}
                        >
                          {({ copied, copy }) => (
                            <Tooltip label="Copy invite link">
                              <ActionIcon onClick={copy}>
                                {copied ? <IconCheck /> : <IconClipboard />}
                              </ActionIcon>
                            </Tooltip>
                          )}
                        </CopyButton>
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
                          loading={deletingInvite}
                          onClick={() => {
                            onDeleteInvite(invite.id);
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
