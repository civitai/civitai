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
  createStyles,
  ActionIcon,
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
import JSZip from 'jszip';
import {
  getVaultItemDownloadUrls,
  useMutateVault,
  useQueryVault,
} from '~/components/Vault/vault.util';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { formatKBytes } from '~/utils/number-helpers';
import { useQueryVaultItems } from '../../components/Vault/vault.util';
import {
  GetPaginatedVaultItemsSchema,
  VaultItemMetadataSchema,
} from '~/server/schema/vault.schema';
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
import { NextLink } from '@mantine/next';
import { VaultItemStatus } from '@prisma/client';
import { VaultSort } from '~/server/common/enums';
import { SelectMenuV2 } from '~/components/SelectMenu/SelectMenu';
import { dbRead } from '~/server/db/client';
import { getVaultState } from '~/utils/vault';
import { useIsMobile } from '~/hooks/useIsMobile';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { Meta } from '~/components/Meta/Meta';
import { isDefined } from '~/utils/type-guards';
import { saveAs } from 'file-saver';
import { sleep } from '~/server/utils/concurrency-helpers';

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

const useStyles = createStyles((theme) => ({
  selected: { background: theme.fn.rgba(theme.colors.blue[8], 0.3), color: theme.colors.gray[0] },
  mobileCard: {
    position: 'relative',
    color: 'white',
    width: '100%',
    borderRadius: theme.radius.md,
    overflow: 'hidden',

    ['& .mantine-Stack-root']: {
      background: 'linear-gradient(transparent, rgba(0,0,0,.6))',
      color: 'white',
      position: 'absolute',
      width: '100%',
      maxHeight: '50%',
      bottom: 0,
      top: 'initial',
      padding: theme.spacing.sm,
      alignItems: 'flex-start',
    },
  },
}));

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
  const { classes, cx } = useStyles();

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

        <ScrollArea.Autosize maxHeight={500}>
          <Stack>
            {vaultItems.map((item) => (
              <Paper withBorder p="sm" radius="lg" key={item.id}>
                <Group noWrap>
                  {item.coverImageUrl && (
                    <Image
                      src={item.coverImageUrl}
                      alt="Model Image"
                      radius="sm"
                      width={50}
                      height={50}
                    />
                  )}
                  <Stack spacing={0}>
                    <Text>{item.modelName}</Text>
                    <Text color="dimmed" size="sm">
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
        window.open(file, '_blank');
        // Some delay between window open to avoid popup blockers
        // And also to avoid the myriad of tabs being opened at once.
        await sleep(1500);
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
    <Modal {...dialog} size="md" withCloseButton title={`Deleting ${vaultItems.length} models`}>
      <Stack>
        <Text size="sm">Models deleted from your Vault cannot be retrieved.</Text>

        <ScrollArea.Autosize maxHeight={500}>
          <Stack>
            {vaultItems.map((item) => (
              <Paper withBorder p="sm" radius="lg" key={item.id}>
                <Group noWrap>
                  {item.coverImageUrl && (
                    <Image
                      src={item.coverImageUrl}
                      alt="Model Image"
                      radius="sm"
                      width={50}
                      height={50}
                    />
                  )}
                  <Stack spacing={0}>
                    <Text>{item.modelName}</Text>
                    <Text color="dimmed" size="sm">
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
          orientation="horizontal"
          label="Select what items to download"
          description="You can download the model, details, and images of the selected models. Only the main model file will be downloaded when doing a multi-download."
          onChange={(values) => {
            setDownloadables(values);
          }}
        >
          {downloadableOptions.map((item) => (
            <Checkbox key={item.value} value={item.value} label={item.label}>
              {item.label}
            </Checkbox>
          ))}
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
        <ActionIcon ml="auto">
          <IconDownload />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {vaultItem.files.map((f) => (
          <Menu.Item
            key={f.id}
            component={NextLink}
            href={`/api/download/vault/${vaultItem.id}?type=model&fileId=${f.id}`}
          >
            <Stack spacing={0}>
              <Text>{f.displayName}</Text>
              <Text size="xs" color="dimmed">
                {formatKBytes(f.sizeKB)}
              </Text>
            </Stack>
          </Menu.Item>
        ))}
        <Menu.Item component={NextLink} href={`/api/download/vault/${vaultItem.id}?type=details`}>
          <Stack spacing={0}>
            <Text>Details</Text>
            <Text size="xs" color="dimmed">
              {formatKBytes(vaultItem.detailsSizeKb)}
            </Text>
          </Stack>
        </Menu.Item>
        <Menu.Item component={NextLink} href={`/api/download/vault/${vaultItem.id}?type=images`}>
          <Stack>
            <Text>Images</Text>
            <Text size="xs" color="dimmed">
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
    <ActionIcon component="a" href="/product/vault" sx={{ alignSelf: 'center' }}>
      <Text color="dimmed" inline>
        <IconHelpCircle />
      </Text>
    </ActionIcon>
  </Tooltip>
);

const MobileVault = () => {
  const { isLoading: isLoadingVault } = useQueryVault();
  const { items, isLoading: isLoadingVaultItems } = useQueryVaultItems(
    {},
    { keepPreviousData: true }
  );
  const { classes } = useStyles();

  return (
    <Container size="xl">
      <Stack mb="xl">
        <Group spacing="xs">
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
                    <AspectRatio ratio={1} className={classes.mobileCard}>
                      {item.coverImageUrl && (
                        <Image
                          src={item.coverImageUrl}
                          alt="Model Image"
                          radius="sm"
                          width="100%"
                          height="100%"
                        />
                      )}
                      <Stack spacing={0}>
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
  const { classes, cx } = useStyles();
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
          <Group position="apart" align="flex-end">
            <Title order={1}>Civitai Vault</Title>
            {vaultHelp}
            <Group ml="auto" align="start">
              {vault && vault.storageKb > 0 && (
                <Stack spacing={0}>
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
                <Button component={NextLink} href="/pricing" variant="outline" size="sm">
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
                  <SelectMenuV2
                    label={getDisplayName(filters.sort)}
                    options={Object.values(VaultSort).map((v) => ({ label: v, value: v }))}
                    value={filters.sort}
                    // Resets page:
                    onClick={(x) => setFilters((c) => ({ ...c, sort: x as VaultSort, page: 1 }))}
                    buttonProps={{ size: undefined, compact: false }}
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
                <thead>
                  <tr>
                    <th style={{ width: 50 }}>
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
                    <th>Size</th>
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
                          <Text align="center" size="lg">
                            No items in your Vault.
                          </Text>
                        </Stack>
                      </td>
                    </tr>
                  )}
                  {items.map((item) => {
                    const isSelected = !!selectedItems.find((i) => i.id === item.id);
                    const meta = (item.meta ?? {}) as VaultItemMetadataSchema;

                    return (
                      <tr
                        key={item.id}
                        className={cx({
                          [classes.selected]: isSelected,
                        })}
                      >
                        <td width={50}>
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
                          <Group>
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
                            <Stack spacing={0}>
                              <Anchor
                                href={`/models/${item.modelId}?modelVersionId=${item.modelVersionId}`}
                              >
                                <Text>{item.modelName}</Text>
                              </Anchor>
                              <Text color="dimmed" size="sm">
                                {item.versionName}
                              </Text>
                            </Stack>
                          </Group>
                        </td>
                        <td>
                          <Anchor href={`/user/${item.creatorName}`}>{item.creatorName}</Anchor>
                        </td>
                        <td>
                          <Group spacing={4}>
                            <Badge size="sm" color="blue" variant="light">
                              {getDisplayName(item.type)}
                            </Badge>
                            <Badge size="sm" color="gray" variant="outline">
                              {getDisplayName(item.baseModel)}
                            </Badge>
                          </Group>
                        </td>
                        <td>
                          <Text transform="capitalize">{getDisplayName(item.category)}</Text>
                        </td>
                        <td>
                          {formatKBytes(
                            (item.modelSizeKb ?? 0) +
                              (item.imagesSizeKb ?? 0) +
                              (item.detailsSizeKb ?? 0)
                          )}
                        </td>
                        <td>{formatDate(item.createdAt)}</td>
                        <td>{formatDate(item.addedAt)}</td>
                        <td>{item.refreshedAt ? formatDate(item.refreshedAt) : '-'}</td>
                        <td>
                          <Stack maw="25vw">
                            <ContentClamp maxHeight={48}>
                              {item.notes && <Text>{item.notes ?? '-'}</Text>}
                            </ContentClamp>
                          </Stack>
                        </td>
                        <td>
                          {item.status === VaultItemStatus.Stored && (
                            <VaultItemDownload vaultItem={item} />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
              {pagination && pagination.totalPages > 1 && (
                <Group position="apart">
                  <Text>Total {pagination.totalItems.toLocaleString()} items</Text>
                  <Pagination
                    page={filters.page}
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
