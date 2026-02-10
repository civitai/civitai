import {
  Badge,
  Button,
  Center,
  Container,
  Divider,
  Group,
  Loader,
  LoadingOverlay,
  MultiSelect,
  Paper,
  Select,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
  ThemeIcon,
  Tooltip,
} from '@mantine/core';
import { DatePickerInput } from '@mantine/dates';
import { useDebouncedValue, useDisclosure } from '@mantine/hooks';
import {
  IconArrowLeft,
  IconCalendar,
  IconCalendarDue,
  IconChevronDown,
  IconChevronRight,
  IconCloudOff,
  IconHistory,
  IconPhoto,
  IconRosette,
  IconTrash,
  IconUpload,
  IconX,
} from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { Dropzone } from '@mantine/dropzone';
import { BackButton } from '~/components/BackButton/BackButton';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Meta } from '~/components/Meta/Meta';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { IMAGE_MIME_TYPE } from '~/shared/constants/mime-types';
import { formatBytes } from '~/utils/number-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { constants } from '~/server/common/constants';
import { MediaType } from '~/shared/utils/prisma/enums';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    if (!session || !session?.user?.isModerator)
      return {
        redirect: {
          destination: '/',
          permanent: false,
        },
      };
  },
});

type ProductWithBadge = {
  id: string;
  name: string;
  provider: string;
  tier?: string;
  badgeType?: string;
  currentBadge: {
    id: number;
    name: string;
    url: string | null;
    animated: boolean;
    availableStart: Date | null;
    availableEnd: Date | null;
  } | null;
};

function BadgeHistoryRow({ productId, productName }: { productId: string; productName: string }) {
  const [opened, { toggle }] = useDisclosure(false);
  const { data: history, isLoading } = trpc.productBadge.getBadgeHistory.useQuery(
    { productId },
    { enabled: opened }
  );

  return (
    <>
      <Table.Tr>
        <Table.Td colSpan={7} p={0}>
          <Button
            variant="subtle"
            size="xs"
            onClick={toggle}
            leftSection={opened ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
            fullWidth
            justify="flex-start"
            pl="md"
          >
            <IconHistory size={14} />
            <Text ml={4} size="xs">
              Badge history for {productName} ({history?.length ?? '...'})
            </Text>
          </Button>
        </Table.Td>
      </Table.Tr>
      {opened && (
        <Table.Tr>
          <Table.Td colSpan={7} bg="var(--mantine-color-dark-7)" p="sm">
            {isLoading ? (
              <Center p="sm">
                <Loader size="sm" />
              </Center>
            ) : history && history.length > 0 ? (
              <Stack gap="xs">
                {history.map((badge) => (
                  <Group key={badge.id} gap="sm" align="center">
                    {badge.url ? (
                      <div style={{ width: 30, height: 30, flexShrink: 0 }}>
                        <EdgeMedia
                          src={badge.url}
                          type={MediaType.image}
                          width={30}
                          style={{ width: 30, height: 30, objectFit: 'contain' }}
                        />
                      </div>
                    ) : (
                      <div style={{ width: 30, height: 30, flexShrink: 0 }} />
                    )}
                    <Text size="xs" fw={500} style={{ flex: 1 }}>
                      {badge.name}
                    </Text>
                    {badge.animated && (
                      <Badge size="xs" variant="dot" color="orange">
                        Animated
                      </Badge>
                    )}
                    <Text size="xs" c="dimmed">
                      {badge.availableStart
                        ? new Date(badge.availableStart).toLocaleDateString()
                        : '?'}{' '}
                      -{' '}
                      {badge.availableEnd ? new Date(badge.availableEnd).toLocaleDateString() : '?'}
                    </Text>
                    <Badge size="xs" color="gray" variant="light">
                      ID: {badge.id}
                    </Badge>
                  </Group>
                ))}
              </Stack>
            ) : (
              <Text size="xs" c="dimmed" ta="center">
                No badge history
              </Text>
            )}
          </Table.Td>
        </Table.Tr>
      )}
    </>
  );
}

function BadgeForm({
  mode,
  editingId,
  product,
  products,
  onSuccess,
  onCancel,
}: {
  mode: 'create' | 'edit';
  editingId: number | null;
  product: ProductWithBadge | null;
  products: ProductWithBadge[];
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const badge = mode === 'edit' && product?.currentBadge ? product.currentBadge : null;

  const [formName, setFormName] = useState(badge?.name ?? '');
  const [formAnimated, setFormAnimated] = useState(badge?.animated ?? false);
  const [formProductIds, setFormProductIds] = useState<string[]>(product ? [product.id] : []);
  const [formAvailableStart, setFormAvailableStart] = useState<Date | null>(
    badge?.availableStart ? new Date(badge.availableStart) : null
  );
  const [formAvailableEnd, setFormAvailableEnd] = useState<Date | null>(
    badge?.availableEnd ? new Date(badge.availableEnd) : null
  );

  // Image upload
  const { uploadToCF, files: imageFiles, resetFiles } = useCFImageUpload();
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(badge?.url ?? null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(badge?.url ?? null);

  const queryUtils = trpc.useUtils();
  const upsertMutation = trpc.productBadge.upsertProductBadge.useMutation({
    onSuccess() {
      showSuccessNotification({
        title: 'Badge saved',
        message:
          mode === 'edit'
            ? 'Badge cosmetic updated.'
            : 'New badge cosmetic(s) created. They will be delivered to subscribers automatically.',
      });
      queryUtils.productBadge.getProductsWithBadges.invalidate();
      queryUtils.productBadge.getBadgeHistory.invalidate();
      onSuccess();
    },
    onError(error) {
      showErrorNotification({
        title: 'Failed to save badge',
        error: new Error(error.message),
      });
    },
  });

  const productSelectData = useMemo(() => {
    return products.map((p) => ({
      value: p.id,
      label: `${p.name} (${p.provider}${p.tier ? ` / ${p.tier}` : ''})`,
    }));
  }, [products]);

  const handleDrop = async (files: File[]) => {
    const [file] = files;
    if (!file) return;

    const maxSize = constants.mediaUpload.maxImageFileSize;
    if (file.size > maxSize) {
      showErrorNotification({
        title: 'File too large',
        error: new Error(`File should not exceed ${formatBytes(maxSize)}`),
      });
      return;
    }

    const result = await uploadToCF(file);
    setUploadedUrl(result.id);
    setPreviewUrl(result.objectUrl ?? result.id);
  };

  const handleRemoveImage = () => {
    setUploadedUrl(null);
    setPreviewUrl(null);
    resetFiles();
  };

  const handleSubmit = () => {
    if (!uploadedUrl) {
      showErrorNotification({ title: 'Missing badge', error: new Error('Upload a badge image') });
      return;
    }
    if (!formName.trim()) {
      showErrorNotification({ title: 'Missing name', error: new Error('Enter a badge name') });
      return;
    }
    if (formProductIds.length === 0) {
      showErrorNotification({
        title: 'Missing products',
        error: new Error('Select at least one product'),
      });
      return;
    }
    if (!formAvailableStart || !formAvailableEnd) {
      showErrorNotification({
        title: 'Missing dates',
        error: new Error('Set both start and end dates'),
      });
      return;
    }

    upsertMutation.mutate({
      id: editingId ?? undefined,
      name: formName,
      badgeUrl: uploadedUrl,
      animated: formAnimated,
      productIds: formProductIds,
      availableStart: formAvailableStart,
      availableEnd: formAvailableEnd,
    });
  };

  const imageFile = imageFiles[0];
  const showLoading = imageFile && imageFile.progress < 100;

  return (
    <Stack gap="md">
      {/* Header with context */}
      <Group gap="sm" wrap="nowrap">
        <Button
          variant="subtle"
          color="gray"
          leftSection={<IconArrowLeft size={16} />}
          onClick={onCancel}
          size="sm"
        >
          Back to products
        </Button>
      </Group>

      <Paper withBorder p="lg" radius="md">
        <Stack gap="md">
          <Group gap="xs">
            <IconRosette size={24} />
            <Title order={3}>{mode === 'edit' ? 'Edit Existing Badge' : 'Create New Badge'}</Title>
          </Group>

          {/* Show selected product context */}
          {product && (
            <Paper withBorder p="sm" radius="sm" bg="var(--mantine-color-dark-7)">
              <Group gap="sm">
                <Text size="sm" fw={500}>
                  Product:
                </Text>
                <Text size="sm">{product.name}</Text>
                <Badge
                  color={
                    product.provider === 'Stripe'
                      ? 'violet'
                      : product.provider === 'Paddle'
                      ? 'blue'
                      : 'green'
                  }
                  variant="light"
                  size="sm"
                >
                  {product.provider}
                </Badge>
                {product.tier && (
                  <Badge variant="outline" size="sm" tt="capitalize">
                    {product.tier}
                  </Badge>
                )}
                {mode === 'edit' && product.currentBadge?.url && (
                  <>
                    <Divider orientation="vertical" />
                    <Text size="sm" c="dimmed">
                      Current badge:
                    </Text>
                    <div style={{ width: 28, height: 28 }}>
                      <EdgeMedia
                        src={product.currentBadge.url}
                        type={MediaType.image}
                        width={28}
                        style={{ width: 28, height: 28, objectFit: 'contain' }}
                      />
                    </div>
                    <Text size="xs" c="dimmed">
                      {product.currentBadge.name}
                    </Text>
                  </>
                )}
              </Group>
            </Paper>
          )}

          {mode === 'edit' ? (
            <Text size="sm" c="yellow">
              Editing cosmetic ID {editingId}. This updates the existing record in place.
            </Text>
          ) : (
            <Text size="sm" c="dimmed">
              Creates a new cosmetic record per selected product. Old badges are preserved.
            </Text>
          )}

          {/* Badge Image Upload */}
          <div>
            <Text fw={500} size="sm" mb={4}>
              Badge Image <span style={{ color: 'var(--mantine-color-red-6)' }}>*</span>
            </Text>
            {showLoading ? (
              <Paper style={{ position: 'relative', width: '100%', height: 150 }} withBorder>
                <LoadingOverlay visible />
              </Paper>
            ) : previewUrl ? (
              <div style={{ position: 'relative', display: 'inline-block' }}>
                <LegacyActionIcon
                  size="sm"
                  variant="filled"
                  color="red"
                  onClick={handleRemoveImage}
                  className="absolute right-1 top-1 z-[1]"
                >
                  <IconTrash size={14} />
                </LegacyActionIcon>
                <Paper withBorder p="sm" radius="md">
                  <EdgeMedia
                    src={previewUrl}
                    type={MediaType.image}
                    width={120}
                    style={{ width: 120, height: 120, objectFit: 'contain' }}
                    anim
                  />
                </Paper>
              </div>
            ) : (
              <Dropzone
                accept={IMAGE_MIME_TYPE}
                onDrop={handleDrop}
                maxFiles={1}
                style={{ maxWidth: 400 }}
              >
                <Dropzone.Accept>
                  <Group justify="center" gap="xs">
                    <IconUpload size={32} stroke={1.5} className="text-blue-6 dark:text-blue-4" />
                    <Text c="dimmed">Drop badge image here</Text>
                  </Group>
                </Dropzone.Accept>
                <Dropzone.Reject>
                  <Group justify="center" gap="xs">
                    <IconX size={32} stroke={1.5} className="text-red-6 dark:text-red-4" />
                    <Text>File not accepted</Text>
                  </Group>
                </Dropzone.Reject>
                <Dropzone.Idle>
                  <Group justify="center" gap="xs" p="sm">
                    <IconPhoto size={32} stroke={1.5} />
                    <Text c="dimmed">Drop badge image here or click to browse</Text>
                  </Group>
                </Dropzone.Idle>
              </Dropzone>
            )}
          </div>

          {/* Name */}
          <TextInput
            label="Badge Name"
            description='e.g. "February 2025 Gold Badge"'
            placeholder="Enter badge name"
            value={formName}
            onChange={(e) => setFormName(e.currentTarget.value)}
            withAsterisk
            maw={500}
          />

          {/* Animated */}
          <Switch
            label="Animated Badge"
            description="Toggle on if this badge is animated (GIF/APNG)"
            checked={formAnimated}
            onChange={(e) => setFormAnimated(e.currentTarget.checked)}
          />

          {/* Products */}
          {mode === 'create' && (
            <MultiSelect
              label="Assign to Products"
              description="Select one or more products. A separate cosmetic record is created for each."
              data={productSelectData}
              value={formProductIds}
              onChange={setFormProductIds}
              searchable
              withAsterisk
              placeholder="Search and select products..."
              maw={600}
            />
          )}

          {/* Dates */}
          <Group gap="md" grow maw={600}>
            <DatePickerInput
              label="Available Start"
              placeholder="Select start date"
              leftSection={<IconCalendar size={16} />}
              value={formAvailableStart}
              onChange={setFormAvailableStart}
              clearable
              withAsterisk
            />
            <DatePickerInput
              label="Available End"
              placeholder="Select end date"
              leftSection={<IconCalendarDue size={16} />}
              value={formAvailableEnd}
              onChange={setFormAvailableEnd}
              clearable
              withAsterisk
            />
          </Group>

          {/* Actions */}
          <Group>
            <Button onClick={handleSubmit} loading={upsertMutation.isLoading}>
              {mode === 'edit' ? 'Update Badge' : 'Create Badge'}
            </Button>
            <Button variant="subtle" color="gray" onClick={onCancel}>
              Cancel
            </Button>
          </Group>
        </Stack>
      </Paper>
    </Stack>
  );
}

export default function BadgeManagement() {
  const [nameFilter, setNameFilter] = useState('');
  const [providerFilter, setProviderFilter] = useState<string | null>(null);
  const [debouncedName] = useDebouncedValue(nameFilter, 300);

  // View state: 'list' shows the product table, 'form' shows the badge form
  const [view, setView] = useState<'list' | 'form'>('list');
  const [formMode, setFormMode] = useState<'create' | 'edit'>('create');
  const [selectedProduct, setSelectedProduct] = useState<ProductWithBadge | null>(null);
  const [editingBadgeId, setEditingBadgeId] = useState<number | null>(null);

  const { data: products, isLoading } = trpc.productBadge.getProductsWithBadges.useQuery({
    name: debouncedName || undefined,
    provider: providerFilter || undefined,
  });

  const handleNewBadge = (product: ProductWithBadge) => {
    setSelectedProduct(product);
    setEditingBadgeId(null);
    setFormMode('create');
    setView('form');
  };

  const handleEditBadge = (product: ProductWithBadge) => {
    if (!product.currentBadge) return;
    setSelectedProduct(product);
    setEditingBadgeId(product.currentBadge.id);
    setFormMode('edit');
    setView('form');
  };

  const handleFormDone = () => {
    setView('list');
    setSelectedProduct(null);
    setEditingBadgeId(null);
  };

  if (view === 'form' && products) {
    return (
      <>
        <Meta title="Product Badge Management" deIndex />
        <Container size="lg" pb="xl">
          <Stack gap="xl">
            <Group gap="md" wrap="nowrap">
              <BackButton url="/moderator/cosmetic-store" />
              <Title order={1}>Product Badge Management</Title>
            </Group>
            <BadgeForm
              mode={formMode}
              editingId={editingBadgeId}
              product={selectedProduct}
              products={products}
              onSuccess={handleFormDone}
              onCancel={handleFormDone}
            />
          </Stack>
        </Container>
      </>
    );
  }

  return (
    <>
      <Meta title="Product Badge Management" deIndex />
      <Container size="lg" pb="xl">
        <Stack gap="xl">
          {/* Header */}
          <Group gap="md" wrap="nowrap">
            <BackButton url="/moderator/cosmetic-store" />
            <Stack gap={0}>
              <Title order={1}>Product Badge Management</Title>
              <Text size="sm" c="dimmed">
                Manage monthly badge cosmetics for subscription products. Click &quot;New&quot; to
                create a badge or &quot;Edit&quot; to modify the current one. Old badges are never
                deleted.
              </Text>
            </Stack>
          </Group>

          {/* Filters */}
          <Group>
            <TextInput
              label="Search products"
              placeholder="Product name..."
              value={nameFilter}
              onChange={(e) => setNameFilter(e.currentTarget.value)}
              miw={250}
            />
            <Select
              label="Provider"
              placeholder="All providers"
              data={[
                { value: 'Stripe', label: 'Stripe' },
                { value: 'Paddle', label: 'Paddle' },
                { value: 'Civitai', label: 'Civitai' },
              ]}
              value={providerFilter}
              onChange={setProviderFilter}
              clearable
            />
          </Group>

          {/* Product Badge Table */}
          {isLoading ? (
            <Center p="xl">
              <Loader />
            </Center>
          ) : products && products.length > 0 ? (
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Product</Table.Th>
                  <Table.Th>Provider</Table.Th>
                  <Table.Th>Tier</Table.Th>
                  <Table.Th>Badge Type</Table.Th>
                  <Table.Th>Current Badge</Table.Th>
                  <Table.Th>Badge Period</Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {products.map((product) => (
                  <>
                    <Table.Tr key={product.id}>
                      <Table.Td>
                        <Text size="sm" fw={500} maw={250} lineClamp={2}>
                          {product.name}
                        </Text>
                        <Text size="xs" c="dimmed" lineClamp={1}>
                          {product.id}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge
                          color={
                            product.provider === 'Stripe'
                              ? 'violet'
                              : product.provider === 'Paddle'
                              ? 'blue'
                              : 'green'
                          }
                          variant="light"
                          size="sm"
                        >
                          {product.provider}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" tt="capitalize">
                          {product.tier ?? '-'}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" tt="capitalize">
                          {product.badgeType ?? 'none'}
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        {product.currentBadge?.url ? (
                          <Group gap="xs" align="center">
                            <div style={{ width: 40, height: 40 }}>
                              <EdgeMedia
                                src={product.currentBadge.url}
                                type={MediaType.image}
                                width={40}
                                style={{ width: 40, height: 40, objectFit: 'contain' }}
                              />
                            </div>
                            <Stack gap={0}>
                              <Text size="xs" lineClamp={1}>
                                {product.currentBadge.name}
                              </Text>
                              {product.currentBadge.animated && (
                                <Badge size="xs" variant="dot" color="orange">
                                  Animated
                                </Badge>
                              )}
                            </Stack>
                          </Group>
                        ) : (
                          <Text size="sm" c="dimmed" fs="italic">
                            No badge
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        {product.currentBadge?.availableStart &&
                        product.currentBadge?.availableEnd ? (
                          <Text size="xs" c="dimmed">
                            {new Date(product.currentBadge.availableStart).toLocaleDateString()} -{' '}
                            {new Date(product.currentBadge.availableEnd).toLocaleDateString()}
                          </Text>
                        ) : (
                          <Text size="sm" c="dimmed">
                            -
                          </Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4} wrap="nowrap">
                          <Tooltip label="Create a new badge for this product">
                            <Button
                              size="xs"
                              variant="light"
                              onClick={() => handleNewBadge(product)}
                            >
                              New
                            </Button>
                          </Tooltip>
                          {product.currentBadge && (
                            <Tooltip label="Edit the current badge (fix name, dates, image)">
                              <Button
                                size="xs"
                                variant="subtle"
                                onClick={() => handleEditBadge(product)}
                              >
                                Edit
                              </Button>
                            </Tooltip>
                          )}
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                    <BadgeHistoryRow
                      key={`history-${product.id}`}
                      productId={product.id}
                      productName={product.name}
                    />
                  </>
                ))}
              </Table.Tbody>
            </Table>
          ) : (
            <Stack align="center" py="xl">
              <ThemeIcon size={62} radius={100}>
                <IconCloudOff />
              </ThemeIcon>
              <Text ta="center">No products found.</Text>
            </Stack>
          )}
        </Stack>
      </Container>
    </>
  );
}
