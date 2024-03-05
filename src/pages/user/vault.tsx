import {
  Button,
  Center,
  Checkbox,
  Container,
  Divider,
  Group,
  Loader,
  LoadingOverlay,
  Modal,
  Pagination,
  Progress,
  Stack,
  Table,
  Text,
  TextInput,
  Textarea,
  ThemeIcon,
  Title,
  Paper,
  ScrollArea,
} from '@mantine/core';
import { IconCloudOff, IconSearch } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { useMutateVault, useQueryVault } from '~/components/Vault/vault.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { formatKBytes } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';
import { useQueryVaultItems } from '../../components/Vault/vault.util';
import { GetPaginatedVaultItemsSchema } from '~/server/schema/vault.schema';
import { formatDate } from '~/utils/date-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { isEqual, uniqBy } from 'lodash-es';
import { useDebouncedValue } from '@mantine/hooks';
import { VaultItemsFiltersDropdown } from '~/components/Vault/VaultItemsFiltersDropdown';
import { IconX } from '@tabler/icons-react';
import { VaultItemGetPaged } from '~/types/router';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { showSuccessNotification } from '~/utils/notifications';
import { dialogStore } from '~/components/Dialog/dialogStore';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx, features }) => {
    if (!session)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl, reason: 'civitai-vault' }),
          permanent: false,
        },
      };

    if (!session.user?.subscriptionId) {
      return {
        redirect: {
          destination: '/pricing',
          permanent: false,
        },
      };
    }
  },
});

const VaultItemsAddNote = ({ vaultItems }: { vaultItems: VaultItemGetPaged[] }) => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const { updateItemsNotes, updatingItemsNotes } = useMutateVault();
  const [notes, setNotes] = useState('');

  const handleConfirm = async () => {
    if (updatingItemsNotes) return;

    await updateItemsNotes({
      modelVersionIds: vaultItems.map((item) => item.modelVersionId as number),
      notes,
    });

    showSuccessNotification({
      title: 'Notes have been updated',
      message: 'Notes for your selected items have been updated successfully',
    });

    handleClose();
  };

  return (
    <Modal {...dialog} size="xs" withCloseButton title="Add notes">
      <Stack>
        <Text size="xs">{vaultItems.length} models selected</Text>
        <Divider mx="-lg" />
        <Textarea
          name="notes"
          placeholder="write your notes here..."
          rows={3}
          value={notes}
          onChange={(event) => setNotes(event.currentTarget.value)}
          withAsterisk
        />
        <Button ml="auto" loading={updatingItemsNotes} onClick={handleConfirm}>
          Done
        </Button>
      </Stack>
    </Modal>
  );
};

const VaultItemsRemove = ({ vaultItems }: { vaultItems: VaultItemGetPaged[] }) => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const { removeItems, removingItems } = useMutateVault();

  const handleConfirm = async () => {
    if (removingItems) return;

    await removeItems({
      modelVersionIds: vaultItems.map((item) => item.modelVersionId as number),
    });

    showSuccessNotification({
      title: 'Items removed',
      message: 'Your selected items have been removed and your storage has been freed.',
    });

    handleClose();
  };

  return (
    <Modal {...dialog} size="md" withCloseButton title={`Deleting ${vaultItems.length} models`}>
      <Stack>
        <Text size="sm">Models deleted from your Civit Vault cannot be retrieved.</Text>

        <ScrollArea.Autosize maxHeight={500}>
          {vaultItems.map((item) => (
            <Paper withBorder p="sm" radius="lg" key={item.id}>
              <Group>
                <Text>IMG</Text>
                <Stack spacing={0}>
                  <Text>{item.modelName}</Text>
                  <Text color="dimmed" size="sm">
                    {item.versionName}
                  </Text>
                </Stack>
              </Group>
            </Paper>
          ))}
        </ScrollArea.Autosize>

        <Divider mx="-lg" />
        <Group grow>
          <Button
            ml="auto"
            loading={removingItems}
            onClick={handleConfirm}
            color="red"
            variant="light"
            fullWidth
            radius="xl"
          >
            Confirm delete
          </Button>
          <Button
            ml="auto"
            disabled={removingItems}
            onClick={handleClose}
            color="gray"
            fullWidth
            radius="xl"
          >
            Don&rsquo;t delete
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};

export default function CivitaiVault() {
  const currentUser = useCurrentUser();
  const { vault, isLoading: isLoadingVault } = useQueryVault();
  const [filters, setFilters] = useState<Omit<GetPaginatedVaultItemsSchema, 'limit'>>({
    page: 1,
  });
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);

  const {
    items,
    isLoading: isLoadingVaultItems,
    isRefetching,
    pagination,
  } = useQueryVaultItems(debouncedFilters, { keepPreviousData: true });
  const [selectedItems, setSelectedItems] = useState<VaultItemGetPaged[]>([]);

  const progress = vault ? (vault.usedStorageKb / vault.storageKb) * 100 : 0;

  const allSelectedInPage = useMemo(() => {
    return items.every((item) => selectedItems.find((i) => i.id === item.id));
  }, [items, selectedItems]);

  //#region [useEffect] cancel debounced filters
  useEffect(() => {
    if (isEqual(filters, debouncedFilters)) cancel();
  }, [cancel, debouncedFilters, filters]);
  //#endregion

  return (
    <Container size="xl">
      <Group position="apart" align="flex-end" mb="xl">
        <Title order={1}>Civitai Vaut</Title>
        {vault && (
          <Stack spacing={0}>
            <Progress
              style={{ width: '100%' }}
              size="xl"
              value={progress}
              color={progress >= 100 ? 'red' : 'blue'}
              striped
              animate
            />
            <Text>
              {formatKBytes(vault.usedStorageKb)} of {formatKBytes(vault.storageKb)} Used
            </Text>
          </Stack>
        )}
      </Group>

      {isLoadingVault ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={(isLoadingVaultItems || isRefetching) ?? false} zIndex={9} />

          <Stack>
            <Group position="apart">
              <Group>
                <TextInput
                  radius="xl"
                  variant="filled"
                  icon={<IconSearch size={20} />}
                  onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
                  value={filters.query}
                  placeholder="Models or creators..."
                />
                <VaultItemsFiltersDropdown
                  filters={debouncedFilters}
                  setFilters={(f) => setFilters((c) => ({ ...c, ...f }))}
                />
              </Group>

              <Group>
                {selectedItems.length > 0 && (
                  <Button
                    disabled={selectedItems.length === 0}
                    radius="xl"
                    color="blue"
                    variant="light"
                    onClick={() => {
                      setSelectedItems([]);
                    }}
                    rightIcon={<IconX size={14} />}
                  >
                    {selectedItems.length} selected
                  </Button>
                )}
                <Button
                  disabled={selectedItems.length === 0}
                  radius="xl"
                  color="gray"
                  onClick={() => {
                    dialogStore.trigger({
                      component: VaultItemsAddNote,
                      props: {
                        vaultItems: selectedItems,
                      },
                    });
                  }}
                >
                  Add notes
                </Button>
                <Button
                  disabled={selectedItems.length === 0}
                  radius="xl"
                  color="red"
                  onClick={() => {
                    dialogStore.trigger({
                      component: VaultItemsRemove,
                      props: {
                        vaultItems: selectedItems,
                      },
                    });
                  }}
                >
                  Delete
                </Button>
              </Group>
            </Group>

            <Table>
              <thead>
                <tr>
                  <th>
                    <Checkbox
                      checked={allSelectedInPage}
                      onChange={() => {
                        if (allSelectedInPage) {
                          setSelectedItems((c) =>
                            c.filter((i) => !items.find((item) => item.id === i.id))
                          );
                        } else {
                          setSelectedItems((c) => uniqBy([...c, ...items], 'id'));
                        }
                      }}
                      aria-label="Select all items in page"
                      size="sm"
                    />
                  </th>
                  <th>Models</th>
                  <th>Creator</th>
                  <th>Type</th>
                  <th>Category</th>
                  <th>Date Created</th>
                  <th>Date Added</th>
                  <th>Last Refreshed</th>
                  <th>Notes</th>
                  <th>&nbsp;</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 && (
                  <tr>
                    <td colSpan={9}>
                      <Stack align="center" my="xl">
                        <ThemeIcon size={62} radius={100}>
                          <IconCloudOff />
                        </ThemeIcon>
                        <Text align="center">No items found.</Text>
                      </Stack>
                    </td>
                  </tr>
                )}
                {items.map((item) => {
                  const isSelected = !!selectedItems.find((i) => i.id === item.id);

                  return (
                    <tr key={item.id}>
                      <td>
                        <Checkbox
                          checked={isSelected}
                          onChange={() => {
                            if (isSelected) {
                              setSelectedItems((c) => c.filter((i) => i.id !== item.id));
                            } else {
                              setSelectedItems((c) => [...c, item]);
                            }
                          }}
                          aria-label="Select item"
                          size="sm"
                        />
                      </td>
                      <td>
                        <Stack spacing={0}>
                          <Text>{item.modelName}</Text>
                          <Text color="dimmed" size="sm">
                            {item.versionName}
                          </Text>
                        </Stack>
                      </td>
                      <td>{item.creatorName}</td>
                      <td>{getDisplayName(item.type)}</td>
                      <td>{getDisplayName(item.category)}</td>
                      <td>{formatDate(item.createdAt)}</td>
                      <td>{formatDate(item.addedAt)}</td>
                      <td>{item.refreshedAt ? formatDate(item.refreshedAt) : '-'}</td>
                      <td>{item.notes ?? '-'}</td>
                      <td>&nbsp;</td>
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
          </Stack>
        </div>
      )}
    </Container>
  );
}
