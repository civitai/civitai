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
  Badge,
  Anchor,
  Image,
  Alert,
  Tooltip,
  Grid,
  AspectRatio,
  Menu,
} from '@mantine/core';
import {
  IconCloudCheck,
  IconCloudOff,
  IconCloudUp,
  IconDeviceDesktop,
  IconDownload,
  IconSearch,
  IconHelpCircle,
} from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import {
  getVaultItemDownloadUrls,
  useMutateVault,
  useQueryVault,
} from '~/components/Vault/vault.util';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { formatKBytes } from '~/utils/number-helpers';
import { useQueryVaultItems } from '../../components/Vault/vault.util';
import type {
  GetPaginatedVaultItemsSchema,
  VaultItemMetadataSchema,
} from '~/server/schema/vault.schema';
import { formatDate } from '~/utils/date-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { isEqual, uniqBy } from 'lodash-es';
import { useDebouncedValue } from '@mantine/hooks';
import { VaultItemsFiltersDropdown } from '~/components/Vault/VaultItemsFiltersDropdown';
import { IconX } from '@tabler/icons-react';
import type { VaultItemGetPaged } from '~/types/router';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { showSuccessNotification } from '~/utils/notifications';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { VaultItemStatus } from '~/shared/utils/prisma/enums';
import { VaultSort } from '~/server/common/enums';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import { dbRead } from '~/server/db/client';
import { getVaultState } from '~/utils/vault';
import { useIsMobile } from '~/hooks/useIsMobile';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { Meta } from '~/components/Meta/Meta';
import { isDefined } from '~/utils/type-guards';
import { sleep } from '~/server/utils/concurrency-helpers';
import styles from './vault.module.scss';
import clsx from 'clsx';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx }) => {
    if (!session || !session.user)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl, reason: 'civitai-vault' }),
          permanent: false,
        },
      };

    const hasUsedVault = await dbRead.vault.findFirst({
      where: { userId: session.user.id },
    });

    // If it has never used vault and it's NOT a subscriber, redirect to pricing page
    if (!hasUsedVault && !session.user.subscriptionId)
      return {
        redirect: {
          destination: '/pricing',
          permanent: false,
        },
      };
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
        <Text size="sm">Models deleted from your Vault cannot be retrieved.</Text>

        <ScrollArea.Autosize mah={500}>
          <Stack>
            {vaultItems.map((item) => (
              <Paper withBorder p="sm" radius="lg" key={item.id}>
                <Group wrap="nowrap">
                  {item.coverImageUrl && (
                    <Image
                      src={item.coverImageUrl}
                      alt="Model Image"
                      radius="sm"
                      width={50}
                      height={50}
                    />
                  )}
                  <Stack gap={0}>
                    <Text>{item.modelName}</Text>
                    <Text c="dimmed" size="sm">
                      {item.versionName}
                    </Text>
                  </Stack>
                </Group>
              </Paper>
            ))}
          </Stack>
        </ScrollArea.Autosize>

        <Divider mx="-lg" />
        <Group grow>
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
        </Group>
      </Stack>
    </Modal>
  );
};

function downloadFile(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = ''; // use the filename from the url
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

const VaultItemsDownload = ({ vaultItems }: { vaultItems: VaultItemGetPaged[] }) => {
  const dialog = useDialogContext();
  const handleClose = dialog.onClose;
  const [downloadables, setDownloadables] = useState(['details', 'images', 'model']);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    setError(null);

    try {
      const files = vaultItems
        .map((item) => {
          const { details, images, models } = getVaultItemDownloadUrls(item);
          return [
            downloadables.includes('details') ? details : null,
            downloadables.includes('images') ? images : null,
            downloadables.includes('model') ? models : null,
          ].filter(isDefined);
        })
        .flat();

      for (const file of files) {
        downloadFile(file);
        await sleep(1500); // Keep sleep high to avoid missing downloads for some reason...
      }

      setDownloading(false);
      handleClose();
    } catch (error) {
      console.error(error);
      setError('An error occurred while downloading the files. Please try again later.');
      setDownloading(false);
    }
  };

  const downloadableOptions = [
    { value: 'model', label: 'Model' },
    { value: 'details', label: 'Details' },
    { value: 'images', label: 'Images' },
  ];

  return (
    <Modal {...dialog} size="md" withCloseButton title={`Downloading ${vaultItems.length} models`}>
      <Stack>
        <ScrollArea.Autosize mah={500}>
          <Stack>
            {vaultItems.map((item) => (
              <Paper withBorder p="sm" radius="lg" key={item.id}>
                <Group wrap="nowrap">
                  {item.coverImageUrl && (
                    <Image
                      src={item.coverImageUrl}
                      alt="Model Image"
                      radius="sm"
                      width={50}
                      height={50}
                    />
                  )}
                  <Stack gap={0}>
                    <Text>{item.modelName}</Text>
                    <Text c="dimmed" size="sm">
                      {item.versionName}
                    </Text>
                  </Stack>
                </Group>
              </Paper>
            ))}
          </Stack>
        </ScrollArea.Autosize>

        <Checkbox.Group
          value={downloadables}
          label="Select what items to download"
          description="You can download the model, details, and images of the selected models. Only the main model file will be downloaded when doing a multi-download."
          onChange={(values) => {
            setDownloadables(values);
          }}
        >
          <Group>
            {downloadableOptions.map((item) => (
              <Checkbox key={item.value} value={item.value} label={item.label} />
            ))}
          </Group>
        </Checkbox.Group>

        <Divider mx="-lg" />
        {error && (
          <Text size="sm" color="red">
            {error}
          </Text>
        )}
        <Button
          ml="auto"
          disabled={downloadables.length === 0 || downloading}
          onClick={handleDownload}
          loading={downloading}
          color="blue"
          fullWidth
          radius="xl"
        >
          Download
        </Button>
      </Stack>
    </Modal>
  );
};

const VaultItemDownload = ({ vaultItem }: { vaultItem: VaultItemGetPaged }) => {
  return (
    <Menu withinPortal>
      <Menu.Target>
        <LegacyActionIcon ml="auto">
          <IconDownload />
        </LegacyActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {vaultItem.files.map((f) => (
          <Menu.Item
            key={f.id}
            component={Link}
            href={`/api/download/vault/${vaultItem.id}?type=model&fileId=${f.id}`}
          >
            <Stack gap={0}>
              <Text>{f.displayName}</Text>
              <Text size="xs" c="dimmed">
                {formatKBytes(f.sizeKB)}
              </Text>
            </Stack>
          </Menu.Item>
        ))}
        <Menu.Item component={Link} href={`/api/download/vault/${vaultItem.id}?type=details`}>
          <Stack gap={0}>
            <Text>Details</Text>
            <Text size="xs" c="dimmed">
              {formatKBytes(vaultItem.detailsSizeKb)}
            </Text>
          </Stack>
        </Menu.Item>
        <Menu.Item component={Link} href={`/api/download/vault/${vaultItem.id}?type=images`}>
          <Stack>
            <Text>Images</Text>
            <Text size="xs" c="dimmed">
              {formatKBytes(vaultItem.imagesSizeKb)}
            </Text>
          </Stack>
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
};

const VaultItemsStatusDetailsMap = {
  [VaultItemStatus.Stored]: {
    icon: <IconCloudCheck />,
    tooltip: (meta: VaultItemMetadataSchema) =>
      'This model is stored in your Civit Vault and is ready for you to download.',
  },
  [VaultItemStatus.Pending]: {
    icon: <IconCloudUp />,
    tooltip: (meta: VaultItemMetadataSchema) =>
      'We will be processing this model soon and will be ready to download shortly.',
  },
  [VaultItemStatus.Failed]: {
    icon: <IconCloudOff />,
    tooltip: (meta: VaultItemMetadataSchema) =>
      `This model has failed to process ${meta.failures} times. After 3 failed attempts, the model will be removed from your Civit Vault.`,
  },
};

const VaultStateNotice = () => {
  const { vault } = useQueryVault();

  if (!vault) {
    return null;
  }

  const { isBadState, isPastDownloadLimit, eraseLimit, downloadLimit, canDownload } = getVaultState(
    vault.updatedAt,
    vault.storageKb,
    vault.usedStorageKb
  );

  if (!isBadState) {
    return null;
  }

  return (
    <Alert color="red">
      {isPastDownloadLimit && (
        <Text>
          You cannot download items from your vault because you&rsquo;ve exceeded your storage
          limit. Please upgrade or delete some models to regain the ability to download. After{' '}
          {formatDate(eraseLimit)} we will automatically start deleting models to keep you within
          your storage limit.
        </Text>
      )}

      {canDownload && !isPastDownloadLimit && (
        <Text>
          You have until {formatDate(downloadLimit)} to download things from your Vault. After that
          you will have to delete models to be within your tier storage limit or upgrade again to
          download.
        </Text>
      )}
    </Alert>
  );
};

const vaultHelp = (
  <Tooltip label="What is Civitai Vault?">
    <LegacyActionIcon component="a" href="/product/vault" style={{ alignSelf: 'center' }}>
      <Text c="dimmed" inline>
        <IconHelpCircle />
      </Text>
    </LegacyActionIcon>
  </Tooltip>
);

const MobileVault = () => {
  const { isLoading: isLoadingVault } = useQueryVault();
  const { items, isLoading: isLoadingVaultItems } = useQueryVaultItems(
    {},
    { keepPreviousData: true }
  );

  return (
    <Container size="xl">
      <Stack mb="xl">
        <Group gap="xs">
          <Title order={1}>Civitai Vault</Title>
          {vaultHelp}
        </Group>
        <Alert color="yellow">
          <Group>
            <IconDeviceDesktop />
            <Text>Please use desktop for full functionalities</Text>
          </Group>
        </Alert>
        {(items?.length ?? 0) > 0 && <VaultStateNotice />}
      </Stack>

      {isLoadingVault ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isLoadingVaultItems ?? false} zIndex={9} />

          <Grid>
            {items.length === 0 && (
              <Grid.Col span={12}>
                <Stack align="center" my="xl">
                  <ThemeIcon size={62} radius={100}>
                    <IconCloudOff />
                  </ThemeIcon>
                  <Text align="center">No items in your Vault</Text>
                </Stack>
              </Grid.Col>
            )}
            {items.map((item) => {
              return (
                <Grid.Col span={6} key={item.id}>
                  <Anchor href={`/models/${item.modelId}?modelVersionId=${item.modelVersionId}`}>
                    <AspectRatio ratio={1} className={styles.mobileCard}>
                      {item.coverImageUrl && (
                        <Image
                          src={item.coverImageUrl}
                          alt="Model Image"
                          radius="sm"
                          width="100%"
                          height="100%"
                        />
                      )}
                      <Stack gap={0}>
                        <Text>{item.modelName}</Text>
                        <Text size="sm">{item.versionName}</Text>
                      </Stack>
                    </AspectRatio>
                  </Anchor>
                </Grid.Col>
              );
            })}
          </Grid>
        </div>
      )}
    </Container>
  );
};

export default function CivitaiVault() {
  const { vault, isLoading: isLoadingVault } = useQueryVault();
  const [filters, setFilters] = useState<Omit<GetPaginatedVaultItemsSchema, 'limit'>>({
    page: 1,
    sort: VaultSort.RecentlyAdded,
  });
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);

  const {
    items,
    isLoading: isLoadingVaultItems,
    isRefetching,
    pagination,
  } = useQueryVaultItems(debouncedFilters, { keepPreviousData: true });
  const [selectedItems, setSelectedItems] = useState<VaultItemGetPaged[]>([]);
  const progress = vault
    ? vault.storageKb < vault.usedStorageKb
      ? 100
      : (vault.usedStorageKb / vault.storageKb) * 100
    : 0;
  const allSelectedInPage = useMemo(() => {
    return items.every((item) => selectedItems.find((i) => i.id === item.id));
  }, [items, selectedItems]);
  const isMobile = useIsMobile();

  //#region [useEffect] cancel debounced filters
  useEffect(() => {
    if (isEqual(filters, debouncedFilters)) cancel();
  }, [cancel, debouncedFilters, filters]);
  //#endregion

  if (isMobile) {
    return <MobileVault />;
  }

  return (
    <>
      <Meta title="Civitai Vault" deIndex />
      <Container fluid>
        <Stack mb="xl">
          <Group justify="space-between" align="flex-end">
            <Title order={1}>Civitai Vault</Title>
            {vaultHelp}
            <Group ml="auto" align="start">
              {vault && vault.storageKb > 0 && (
                <Stack gap={0}>
                  <Progress
                    style={{ width: '100%', maxWidth: '400px', marginLeft: 'auto' }}
                    size="xl"
                    value={progress}
                    color={progress >= 100 ? 'red' : 'blue'}
                  />
                  <Text align="right">
                    {progress.toFixed(2)}% of {formatKBytes(vault.storageKb, 0)} Used
                  </Text>
                </Stack>
              )}
              {(progress >= 75 || (vault && vault.storageKb === 0)) && (
                <Button component={Link} href="/pricing" variant="outline" size="sm">
                  Upgrade
                </Button>
              )}
            </Group>
          </Group>
          {(items?.length ?? 0) > 0 && <VaultStateNotice />}
        </Stack>

        {isLoadingVault ? (
          <Center p="xl">
            <Loader />
          </Center>
        ) : (
          <div style={{ position: 'relative' }}>
            <LoadingOverlay visible={(isLoadingVaultItems || isRefetching) ?? false} zIndex={9} />

            <Stack>
              <Group justify="space-between">
                <Group>
                  <TextInput
                    radius="xl"
                    variant="filled"
                    leftSection={<IconSearch size={20} />}
                    onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
                    value={filters.query}
                    placeholder="Models or creators..."
                  />
                  <VaultItemsFiltersDropdown
                    filters={debouncedFilters}
                    setFilters={(f) => setFilters((c) => ({ ...c, ...f }))}
                  />
                  <SelectMenuV2
                    label={getDisplayName(filters.sort)}
                    options={Object.values(VaultSort).map((v) => ({ label: v, value: v }))}
                    value={filters.sort}
                    size="md"
                    variant="default"
                    // Resets page:
                    onClick={(x) => setFilters((c) => ({ ...c, sort: x as VaultSort, page: 1 }))}
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
                      rightSection={<IconX size={14} />}
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
                  {selectedItems.length > 0 &&
                    selectedItems.every((i) => i.status === VaultItemStatus.Stored) && (
                      <Button
                        disabled={selectedItems.length === 0}
                        radius="xl"
                        onClick={() => {
                          dialogStore.trigger({
                            component: VaultItemsDownload,
                            props: {
                              vaultItems: selectedItems,
                            },
                          });
                        }}
                      >
                        Download
                      </Button>
                    )}
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
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th style={{ width: 50 }}>
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
                    </Table.Th>
                    <Table.Th>Models</Table.Th>
                    <Table.Th>Creator</Table.Th>
                    <Table.Th>Type</Table.Th>
                    <Table.Th>Category</Table.Th>
                    <Table.Th>Size</Table.Th>
                    <Table.Th>Date Created</Table.Th>
                    <Table.Th>Date Added</Table.Th>
                    <Table.Th>Last Refreshed</Table.Th>
                    <Table.Th>Notes</Table.Th>
                    <Table.Th>&nbsp;</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {items.length === 0 && (
                    <Table.Tr>
                      <Table.Td colSpan={9}>
                        <Stack align="center" my="xl">
                          <ThemeIcon size={62} radius={100}>
                            <IconCloudOff />
                          </ThemeIcon>
                          <Text align="center" size="lg">
                            No items in your Vault.
                          </Text>
                        </Stack>
                      </Table.Td>
                    </Table.Tr>
                  )}
                  {items.map((item) => {
                    const isSelected = !!selectedItems.find((i) => i.id === item.id);
                    const meta = (item.meta ?? {}) as VaultItemMetadataSchema;

                    return (
                      <Table.Tr
                        key={item.id}
                        className={clsx({
                          [styles.selected]: isSelected,
                        })}
                      >
                        <Table.Td width={50}>
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
                        </Table.Td>
                        <Table.Td>
                          <Group wrap="nowrap">
                            {item.coverImageUrl ? (
                              <Image
                                src={item.coverImageUrl}
                                alt="Model Image"
                                radius="sm"
                                width={50}
                                height={50}
                              />
                            ) : (
                              <Tooltip
                                label={VaultItemsStatusDetailsMap[item.status].tooltip(meta)}
                              >
                                {VaultItemsStatusDetailsMap[item.status].icon}
                              </Tooltip>
                            )}
                            <Stack gap={0}>
                              <Anchor
                                component={Link}
                                href={`/models/${item.modelId}?modelVersionId=${item.modelVersionId}`}
                                lineClamp={2}
                                size="sm"
                              >
                                <Text>{item.modelName}</Text>
                              </Anchor>
                              <Text c="dimmed" size="sm">
                                {item.versionName}
                              </Text>
                            </Stack>
                          </Group>
                        </Table.Td>
                        <Table.Td>
                          <Anchor component={Link} href={`/user/${item.creatorName}`} size="sm">
                            {item.creatorName}
                          </Anchor>
                        </Table.Td>
                        <Table.Td>
                          <Group gap={4}>
                            <Badge size="sm" color="blue" variant="light">
                              {getDisplayName(item.type)}
                            </Badge>
                            <Badge size="sm" color="gray" variant="outline">
                              {getDisplayName(item.baseModel)}
                            </Badge>
                          </Group>
                        </Table.Td>
                        <Table.Td>
                          <Text tt="capitalize">{getDisplayName(item.category)}</Text>
                        </Table.Td>
                        <Table.Td>
                          {formatKBytes(
                            (item.modelSizeKb ?? 0) +
                              (item.imagesSizeKb ?? 0) +
                              (item.detailsSizeKb ?? 0)
                          )}
                        </Table.Td>
                        <Table.Td>{formatDate(item.createdAt)}</Table.Td>
                        <Table.Td>{formatDate(item.addedAt)}</Table.Td>
                        <Table.Td>{item.refreshedAt ? formatDate(item.refreshedAt) : '-'}</Table.Td>
                        <Table.Td>
                          <Stack maw="25vw">
                            <ContentClamp maxHeight={48}>
                              {item.notes && <Text>{item.notes ?? '-'}</Text>}
                            </ContentClamp>
                          </Stack>
                        </Table.Td>
                        <Table.Td>
                          {item.status === VaultItemStatus.Stored && (
                            <VaultItemDownload vaultItem={item} />
                          )}
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
              {pagination && pagination.totalPages > 1 && (
                <Group justify="space-between">
                  <Text>Total {pagination.totalItems.toLocaleString()} items</Text>
                  <Pagination
                    value={filters.page}
                    onChange={(page) => {
                      setFilters((curr) => ({ ...curr, page }));
                      window.scrollTo({ top: 0, behavior: 'smooth' });
                    }}
                    total={pagination.totalPages}
                  />
                </Group>
              )}
            </Stack>
          </div>
        )}
      </Container>
    </>
  );
}
