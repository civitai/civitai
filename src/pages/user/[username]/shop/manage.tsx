import {
  ActionIcon,
  Badge,
  Button,
  Center,
  Chip,
  Group,
  Loader,
  Menu,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from '@mantine/core';
import {
  IconArchive,
  IconArrowsSort,
  IconBolt,
  IconCircleCheck,
  IconClock,
  IconDots,
  IconEdit,
  IconPlus,
  IconSearch,
  IconSettings,
  IconShoppingBag,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useMemo, useState, type ReactNode } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { CreatorShopSettingsModal } from '~/components/CreatorShop/CreatorShopSettingsModal';
import { CreatorShopSubmitModal } from '~/components/CreatorShop/CreatorShopSubmitModal';
import {
  useMutateCreatorShop,
  useQueryCreatorShopManage,
} from '~/components/CreatorShop/creator-shop.util';
import { UserProfileLayout } from '~/components/Profile/ProfileLayout2';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { CosmeticShopItemStatus } from '~/shared/utils/prisma/enums';
import { formatDate } from '~/utils/date-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { getDisplayName, postgresSlugify } from '~/utils/string-helpers';

export const getServerSideProps = createServerSideProps({
  useSSG: false,
  resolver: async ({ ctx, features }) => {
    const username = ctx.query.username as string;
    if (!features?.creatorShop)
      return { redirect: { destination: `/user/${username}`, permanent: false } };
  },
});

const statusMeta: Record<CosmeticShopItemStatus, { label: string; color: string }> = {
  Draft: { label: 'Draft', color: 'gray' },
  PendingReview: { label: 'Pending Review', color: 'yellow' },
  Published: { label: 'Published', color: 'green' },
  Rejected: { label: 'Rejected', color: 'red' },
  Archived: { label: 'Archived', color: 'gray' },
};

const statusFilters: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All' },
  { value: CosmeticShopItemStatus.Published, label: 'Published' },
  { value: CosmeticShopItemStatus.PendingReview, label: 'Pending Review' },
  { value: CosmeticShopItemStatus.Draft, label: 'Draft' },
  { value: CosmeticShopItemStatus.Rejected, label: 'Rejected' },
  { value: CosmeticShopItemStatus.Archived, label: 'Archived' },
];

// Uniform artwork thumbnail — the raw cosmetic image contained in a fixed box.
// (CosmeticSample renders full previews/FeedCards that overflow a table cell.)
function CosmeticThumb({ data, name }: { data: unknown; name: string }) {
  const url = (data as { url?: string } | null)?.url;
  return (
    <div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-md border border-gray-3 bg-gray-0 dark:border-dark-4 dark:bg-dark-6">
      {url ? (
        <EdgeMedia
          src={url}
          width={44}
          alt={name}
          className="h-auto max-h-full w-auto max-w-full object-contain"
        />
      ) : null}
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  color = 'gray',
}: {
  label: string;
  value: number | string;
  icon: ReactNode;
  color?: string;
}) {
  return (
    <Paper
      withBorder
      radius="md"
      p="md"
      style={{
        backgroundColor: `var(--mantine-color-${color}-light)`,
        borderColor: `var(--mantine-color-${color}-outline)`,
      }}
    >
      <Group gap="sm" wrap="nowrap" align="center">
        <ThemeIcon variant="filled" radius="md" size={40} color={color}>
          {icon}
        </ThemeIcon>
        <Stack gap={0} className="min-w-0">
          <Text size="xs" c="dimmed" lineClamp={1}>
            {label}
          </Text>
          <Text
            size="lg"
            fw={700}
            className="whitespace-nowrap"
            style={{ color: `var(--mantine-color-${color}-light-color)` }}
          >
            {value}
          </Text>
        </Stack>
      </Group>
    </Paper>
  );
}

const sortOptions: Array<{ value: string; label: string }> = [
  { value: 'newest', label: 'Newest' },
  { value: 'best', label: 'Best selling' },
  { value: 'revenue', label: 'Top revenue' },
  { value: 'price-high', label: 'Price: High to Low' },
  { value: 'price-low', label: 'Price: Low to High' },
  { value: 'name', label: 'Name (A–Z)' },
];

function ManageShopPage() {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const username = (router.query.username as string) ?? '';
  const isOwner =
    !!currentUser && postgresSlugify(currentUser.username) === postgresSlugify(username);

  const { items, isLoading } = useQueryCreatorShopManage(isOwner);
  const { archiveItem } = useMutateCreatorShop();
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('newest');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const result = items.filter((i) => {
      const statusMatch = status === 'all' || i.status === status;
      const titleMatch = !q || i.title.toLowerCase().includes(q);
      return statusMatch && titleMatch;
    });
    const revenue = (i: (typeof items)[number]) => i.purchases * i.unitAmount;
    switch (sort) {
      case 'best':
        result.sort((a, b) => b.purchases - a.purchases);
        break;
      case 'revenue':
        result.sort((a, b) => revenue(b) - revenue(a));
        break;
      case 'price-high':
        result.sort((a, b) => b.unitAmount - a.unitAmount);
        break;
      case 'price-low':
        result.sort((a, b) => a.unitAmount - b.unitAmount);
        break;
      case 'name':
        result.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case 'newest':
      default:
        result.sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt));
        break;
    }
    return result;
  }, [items, status, search, sort]);

  const stats = useMemo(() => {
    const by = (s: CosmeticShopItemStatus) => items.filter((i) => i.status === s).length;
    return {
      published: by(CosmeticShopItemStatus.Published),
      pending: by(CosmeticShopItemStatus.PendingReview),
      units: items.reduce((sum, i) => sum + i.purchases, 0),
      revenue: items.reduce((sum, i) => sum + i.purchases * i.unitAmount, 0),
    };
  }, [items]);

  if (!username) return <NotFound />;
  if (currentUser && !isOwner) return <NotFound />;

  return (
    <Stack gap="lg" mt="md" pb="xl">
      <Group justify="space-between" align="flex-end">
        <Stack gap={2}>
          <Title order={2}>Your Shop</Title>
          <Text size="sm" c="dimmed">
            Manage your listings and track sales
          </Text>
        </Stack>
        <Group gap="xs">
          <Button
            variant="default"
            leftSection={<IconSettings size={16} />}
            onClick={() => dialogStore.trigger({ component: CreatorShopSettingsModal })}
          >
            Shop settings
          </Button>
          <Button
            leftSection={<IconPlus size={16} />}
            onClick={() => dialogStore.trigger({ component: CreatorShopSubmitModal })}
          >
            Submit an item
          </Button>
        </Group>
      </Group>

      {!isLoading && items.length > 0 && (
        <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="md">
          <StatCard
            label="Published"
            value={stats.published}
            color="green"
            icon={<IconCircleCheck size={20} />}
          />
          <StatCard
            label="Pending review"
            value={stats.pending}
            color="yellow"
            icon={<IconClock size={20} />}
          />
          <StatCard
            label="Units sold"
            value={stats.units}
            color="blue"
            icon={<IconShoppingBag size={20} />}
          />
          <StatCard
            label="Revenue"
            value={`${numberWithCommas(stats.revenue)} Buzz`}
            color="grape"
            icon={<IconBolt size={20} />}
          />
        </SimpleGrid>
      )}

      {!isLoading && items.length > 0 && (
        <Group justify="space-between" align="center" gap="sm" wrap="wrap">
          <Chip.Group multiple={false} value={status} onChange={(v) => setStatus(v as string)}>
            <Group gap={6} wrap="wrap">
              {statusFilters.map((f) => (
                <Chip key={f.value} value={f.value} size="xs" variant="filled">
                  {f.label}
                </Chip>
              ))}
            </Group>
          </Chip.Group>
          <Group gap="xs" wrap="nowrap">
            <TextInput
              placeholder="Search items"
              leftSection={<IconSearch size={16} />}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              size="xs"
              w={200}
            />
            <Select
              data={sortOptions}
              value={sort}
              onChange={(v) => setSort(v ?? 'newest')}
              size="xs"
              w={190}
              allowDeselect={false}
              leftSection={<IconArrowsSort size={16} />}
              comboboxProps={{ withinPortal: true }}
            />
          </Group>
        </Group>
      )}

      {isLoading ? (
        <Center py="xl">
          <Loader />
        </Center>
      ) : filtered.length === 0 ? (
        <Paper withBorder radius="md" p="xl">
          <Stack gap={4} align="center" py="md">
            <Text fw={600}>{items.length === 0 ? 'No items yet' : 'Nothing here'}</Text>
            <Text size="sm" c="dimmed" ta="center">
              {items.length === 0
                ? 'Submit your first item to start selling in your shop.'
                : 'No items match this filter.'}
            </Text>
            {items.length === 0 && (
              <Button
                mt="xs"
                variant="light"
                leftSection={<IconPlus size={16} />}
                onClick={() => dialogStore.trigger({ component: CreatorShopSubmitModal })}
              >
                Submit an item
              </Button>
            )}
          </Stack>
        </Paper>
      ) : (
        <Paper withBorder radius="md" className="overflow-hidden">
          <Table.ScrollContainer minWidth={820}>
            <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover layout="fixed">
              <Table.Thead className="bg-gray-1 dark:bg-dark-6">
                <Table.Tr>
                  <Table.Th>Item</Table.Th>
                  <Table.Th w={110}>Type</Table.Th>
                  <Table.Th w={120}>Price</Table.Th>
                  <Table.Th w={140}>Status</Table.Th>
                  <Table.Th w={80} ta="right">
                    Sales
                  </Table.Th>
                  <Table.Th w={120}>Updated</Table.Th>
                  <Table.Th w={56} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {filtered.map((item) => {
                  const meta = statusMeta[item.status];
                  return (
                    <Table.Tr key={item.id}>
                      <Table.Td>
                        <Group gap="sm" wrap="nowrap" align="center">
                          <CosmeticThumb data={item.cosmetic.data} name={item.title} />
                          <Stack gap={0} className="min-w-0">
                            <Text size="sm" fw={600} lineClamp={1}>
                              {item.title}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {getDisplayName(item.cosmetic.type)}
                            </Text>
                            {item.status === CosmeticShopItemStatus.Rejected &&
                              item.rejectionReason && (
                                <Text size="xs" c="red" mt={2} lineClamp={2}>
                                  Rejected: {item.rejectionReason}
                                </Text>
                              )}
                          </Stack>
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">
                          Cosmetic
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" className="whitespace-nowrap">
                          {numberWithCommas(item.unitAmount)} Buzz
                        </Text>
                      </Table.Td>
                      <Table.Td>
                        <Badge color={meta.color} variant="dot">
                          {meta.label}
                        </Badge>
                      </Table.Td>
                      <Table.Td ta="right">{item.purchases}</Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed" className="whitespace-nowrap">
                          {formatDate(item.createdAt)}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Menu withinPortal position="bottom-end">
                          <Menu.Target>
                            <ActionIcon variant="subtle" color="gray">
                              <IconDots size={18} />
                            </ActionIcon>
                          </Menu.Target>
                          <Menu.Dropdown>
                            <Menu.Item
                              leftSection={<IconEdit size={16} />}
                              disabled={item.status === CosmeticShopItemStatus.Archived}
                              onClick={() =>
                                dialogStore.trigger({
                                  component: CreatorShopSubmitModal,
                                  props: { item },
                                })
                              }
                            >
                              {item.status === CosmeticShopItemStatus.Rejected
                                ? 'Edit & resubmit'
                                : 'Edit'}
                            </Menu.Item>
                            <Menu.Item
                              color="red"
                              leftSection={<IconArchive size={16} />}
                              disabled={
                                item.status === CosmeticShopItemStatus.Archived ||
                                archiveItem.isPending
                              }
                              onClick={() => archiveItem.mutate({ id: item.id })}
                            >
                              Archive
                            </Menu.Item>
                          </Menu.Dropdown>
                        </Menu>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Paper>
      )}
    </Stack>
  );
}

export default Page(ManageShopPage, { getLayout: UserProfileLayout });
