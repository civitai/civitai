import {
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import {
  IconAlertTriangle,
  IconBolt,
  IconBox,
  IconCheck,
  IconCopyright,
  IconEyeOff,
  IconPhotoOff,
  IconScan,
  IconSearch,
  IconShieldCheck,
  IconSparkles,
  IconTag,
  IconTrendingUp,
  IconX,
} from '@tabler/icons-react';
import type { ComponentProps, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import {
  useMutateCreatorShop,
  useQueryCreatorShopReviewQueue,
} from '~/components/CreatorShop/creator-shop.util';
import { CheckRow, ChecksCard } from '~/components/CreatorShop/ChecksCard';
import { CosmeticThumb } from '~/components/CreatorShop/CosmeticThumb';
import { CREATOR_SHOP_BORDER } from '~/components/CreatorShop/creator-shop.constants';
import { CosmeticPreview } from '~/components/CosmeticShop/CosmeticPreview';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import {
  CREATOR_SHOP_CREATOR_SHARE,
  CREATOR_SHOP_SUBMISSION_FEE,
} from '~/server/schema/creator-shop.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { CosmeticShopItemStatus } from '~/shared/utils/prisma/enums';
import { daysFromNow } from '~/utils/date-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { showErrorNotification } from '~/utils/notifications';

type StatusFilter = CosmeticShopItemStatus | 'all';
type PreviewCosmetic = ComponentProps<typeof CosmeticPreview>['cosmetic'];

const statusFilterOptions: { label: string; value: StatusFilter }[] = [
  { label: 'Pending review', value: CosmeticShopItemStatus.PendingReview },
  { label: 'Published', value: CosmeticShopItemStatus.Published },
  { label: 'Rejected', value: CosmeticShopItemStatus.Rejected },
  { label: 'All types', value: 'all' },
];

// Quick-insert reasons a moderator can append to their note.
const flagConcerns = [
  { label: 'Copyright / IP', icon: IconCopyright },
  { label: 'Pricing', icon: IconTag },
  { label: 'Visual quality', icon: IconPhotoOff },
  { label: 'NSFW', icon: IconEyeOff },
];

const artUrl = (data: unknown) => (data as { url?: string } | null)?.url ?? null;

function MoneyTile({
  label,
  value,
  icon,
  iconColor,
}: {
  label: string;
  value: string;
  icon: ReactNode;
  iconColor: string;
}) {
  return (
    <Paper withBorder radius="md" p="sm">
      <Group gap={6} align="center">
        <span style={{ color: iconColor, display: 'flex' }}>{icon}</span>
        <Text size="xs" c="dimmed">
          {label}
        </Text>
      </Group>
      <Text fw={700} className="whitespace-nowrap">
        {value}
      </Text>
    </Paper>
  );
}

export const getServerSideProps = createServerSideProps({
  useSSG: false,
  resolver: async ({ features }) => {
    if (!features?.creatorShop) return { notFound: true };
  },
});

function CreatorShopReviewPage() {
  const currentUser = useCurrentUser();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(
    CosmeticShopItemStatus.PendingReview
  );
  const [usernameInput, setUsernameInput] = useState('');
  const [debouncedUsername] = useDebouncedValue(usernameInput, 300);

  const { data, isLoading } = useQueryCreatorShopReviewQueue({
    enabled: !!currentUser?.isModerator,
    status: statusFilter === 'all' ? undefined : statusFilter,
    username: debouncedUsername,
  });
  const { reviewItem } = useMutateCreatorShop();

  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [reason, setReason] = useState('');

  useEffect(() => {
    setSelectedId((cur) => (cur && items.some((i) => i.id === cur) ? cur : items[0]?.id ?? null));
  }, [items]);

  const selected = items.find((i) => i.id === selectedId) ?? null;
  const selectedMeta = (selected?.meta ?? {}) as CosmeticShopItemMeta;
  const checks = selectedMeta.autoChecks ?? [];
  const dims = selectedMeta.imageMeta;
  const isAnimated = !!(selected?.cosmetic.data as { animated?: boolean } | null)?.animated;

  if (currentUser && !currentUser.isModerator) return <NotFound />;

  const appendFlag = (label: string) =>
    setReason((prev) => (prev.trim() ? `${prev.replace(/\s*$/, '')} ${label}` : label));

  const handleApprove = async () => {
    if (!selected) return;
    await reviewItem.mutateAsync({ id: selected.id, action: 'approve' });
    setReason('');
  };

  // "Request changes" and "Reject" both move the item to Rejected (the creator
  // can then edit & resubmit); the note distinguishes intent for the creator.
  const handleReject = async () => {
    if (!selected) return;
    if (!reason.trim())
      return showErrorNotification({
        title: 'A note is required',
        error: new Error('Add a note so the creator knows what to change.'),
      });
    await reviewItem.mutateAsync({
      id: selected.id,
      action: 'reject',
      rejectionReason: reason.trim(),
    });
    setReason('');
  };

  const pendingCount = statusFilter === CosmeticShopItemStatus.PendingReview ? items.length : null;

  return (
    <Stack gap={0} className="w-full">
      {/* Topbar */}
      <Group
        justify="space-between"
        align="center"
        px="xl"
        py="md"
        style={{ borderBottom: CREATOR_SHOP_BORDER }}
      >
        <Group gap={10} align="center">
          <IconShieldCheck size={20} color="var(--mantine-color-blue-4)" />
          <Title order={4}>Creator Shop · Review Queue</Title>
          {pendingCount != null && (
            <Badge color="yellow" variant="light" radius="xl">
              {pendingCount} pending
            </Badge>
          )}
        </Group>
        <Group gap="sm" align="center">
          <Select
            size="sm"
            w={170}
            value={statusFilter}
            onChange={(v) => setStatusFilter((v as StatusFilter) ?? 'all')}
            data={statusFilterOptions}
            allowDeselect={false}
            comboboxProps={{ withinPortal: true }}
          />
          <TextInput
            size="sm"
            w={220}
            placeholder="Filter by creator"
            value={usernameInput}
            onChange={(e) => setUsernameInput(e.currentTarget.value)}
            leftSection={<IconSearch size={16} />}
          />
        </Group>
      </Group>

      {isLoading ? (
        <Center py={80}>
          <Loader />
        </Center>
      ) : items.length === 0 ? (
        <Center py={80}>
          <Stack align="center" gap={4}>
            <ThemeIcon size={48} radius="xl" variant="light" color="gray">
              <IconShieldCheck size={26} />
            </ThemeIcon>
            <Text fw={600}>Nothing to review</Text>
            <Text size="sm" c="dimmed">
              No items match the current filter.
            </Text>
          </Stack>
        </Center>
      ) : (
        <Group gap={0} align="stretch" wrap="nowrap" style={{ minHeight: 'calc(100vh - 160px)' }}>
          {/* Queue */}
          <div className="shrink-0" style={{ width: 380, borderRight: CREATOR_SHOP_BORDER }}>
            <ScrollArea.Autosize mah="calc(100vh - 160px)">
              <Stack gap={0}>
                {items.map((item) => {
                  const active = item.id === selectedId;
                  return (
                    <UnstyledButton
                      key={item.id}
                      onClick={() => {
                        setSelectedId(item.id);
                        setReason('');
                      }}
                      className="w-full"
                      style={{
                        padding: '12px 14px',
                        borderBottom: CREATOR_SHOP_BORDER,
                        borderLeft: active
                          ? '2px solid var(--mantine-color-blue-6)'
                          : '2px solid transparent',
                        background: active ? 'var(--mantine-color-blue-light)' : undefined,
                      }}
                    >
                      <Group gap={10} wrap="nowrap" align="center">
                        <CosmeticThumb data={item.cosmetic.data} name={item.title} />
                        <Stack gap={2} className="min-w-0" style={{ flex: 1 }}>
                          <Text size="sm" fw={600} lineClamp={1}>
                            {item.title}
                          </Text>
                          <Text size="xs" c="dimmed" lineClamp={1}>
                            @{item.cosmetic.creator?.username ?? 'unknown'} ·{' '}
                            {getDisplayName(item.cosmetic.type)}
                          </Text>
                        </Stack>
                        <Text size="xs" fw={700} className="whitespace-nowrap">
                          {numberWithCommas(item.unitAmount)}
                        </Text>
                      </Group>
                    </UnstyledButton>
                  );
                })}
              </Stack>
            </ScrollArea.Autosize>
          </div>

          {/* Detail */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {selected ? (
              <Stack gap="lg" p="xl">
                <Stack gap={6}>
                  <Group gap={10} align="center" wrap="wrap">
                    <Title order={3}>{selected.title}</Title>
                    <Badge variant="light" color="gray" radius="xl">
                      Cosmetic · {getDisplayName(selected.cosmetic.type)}
                    </Badge>
                  </Group>
                  <Group gap={6} align="center">
                    <Text size="sm" c="dimmed">
                      Submitted by
                    </Text>
                    <Text size="sm" fw={600} c="blue">
                      @{selected.cosmetic.creator?.username ?? 'unknown'}
                    </Text>
                    <Text size="sm" c="dimmed">
                      · {daysFromNow(selected.createdAt)}
                    </Text>
                  </Group>
                </Stack>

                <Group align="flex-start" gap="xl" wrap="nowrap" className="max-md:flex-wrap">
                  {/* Preview */}
                  <Stack gap={10} style={{ width: 340, flexShrink: 0 }} className="max-md:w-full">
                    <div
                      className="flex items-center justify-center overflow-hidden"
                      style={{
                        height: 280,
                        borderRadius: 8,
                        border: CREATOR_SHOP_BORDER,
                        background: 'linear-gradient(135deg, #1A1B1E, #101113)',
                      }}
                    >
                      {artUrl(selected.cosmetic.data) ? (
                        <EdgeMedia
                          src={artUrl(selected.cosmetic.data)!}
                          width={240}
                          alt={selected.title}
                          className="max-h-[240px] max-w-[85%] object-contain"
                        />
                      ) : (
                        <Text size="sm" c="dimmed">
                          No artwork
                        </Text>
                      )}
                    </div>
                    <Text size="xs" c="dimmed" ta="center">
                      Submitted artwork
                      {dims ? ` · ${dims.width}×${dims.height} PNG` : ''}
                    </Text>
                    <div>
                      <Text size="xs" fw={600} c="dimmed" mb={4}>
                        In-context preview
                      </Text>
                      <CosmeticPreview cosmetic={selected.cosmetic as unknown as PreviewCosmetic} />
                    </div>
                  </Stack>

                  {/* Meta */}
                  <Stack gap="md" style={{ flex: 1, minWidth: 0 }}>
                    <SimpleGrid cols={{ base: 1, xs: 3 }} spacing="sm">
                      <MoneyTile
                        label="List price"
                        value={`${numberWithCommas(selected.unitAmount)} Buzz`}
                        icon={<IconBolt size={14} />}
                        iconColor="var(--mantine-color-yellow-5)"
                      />
                      <MoneyTile
                        label="Creator earns"
                        value={`${numberWithCommas(
                          Math.floor(selected.unitAmount * CREATOR_SHOP_CREATOR_SHARE)
                        )} Buzz`}
                        icon={<IconTrendingUp size={14} />}
                        iconColor="var(--mantine-color-green-5)"
                      />
                      <MoneyTile
                        label="Submission fee"
                        value={`${numberWithCommas(CREATOR_SHOP_SUBMISSION_FEE)} · Paid`}
                        icon={<IconCheck size={14} />}
                        iconColor="var(--mantine-color-blue-5)"
                      />
                    </SimpleGrid>

                    <SimpleGrid cols={{ base: 1, xs: 3 }} spacing="sm">
                      <MoneyTile
                        label="Quantity"
                        value={
                          selected.availableQuantity
                            ? `${numberWithCommas(selected.availableQuantity)} available`
                            : 'Unlimited'
                        }
                        icon={<IconBox size={14} />}
                        iconColor="var(--mantine-color-grape-5)"
                      />
                      <MoneyTile
                        label="Animated"
                        value={isAnimated ? 'Yes' : 'No'}
                        icon={<IconSparkles size={14} />}
                        iconColor="var(--mantine-color-pink-5)"
                      />
                      <MoneyTile
                        label="Type"
                        value={getDisplayName(selected.cosmetic.type)}
                        icon={<IconTag size={14} />}
                        iconColor="var(--mantine-color-cyan-5)"
                      />
                    </SimpleGrid>

                    <ChecksCard
                      icon={<IconScan size={15} color="var(--mantine-color-dimmed)" />}
                      title="Automated checks"
                    >
                      {checks.length ? (
                        checks.map((c, i) => (
                          <CheckRow
                            key={c.key}
                            state={c.passed ? 'pass' : 'fail'}
                            label={c.label}
                            detail={c.detail}
                            withBorder={i < checks.length - 1}
                          />
                        ))
                      ) : (
                        <Group gap={9} px="md" py={9} align="center">
                          <IconAlertTriangle size={16} color="var(--mantine-color-yellow-5)" />
                          <Text size="sm" c="dimmed">
                            No automated checks were recorded for this submission.
                          </Text>
                        </Group>
                      )}
                    </ChecksCard>

                    {!!selected.description && (
                      <Text size="sm" c="dimmed">
                        {selected.description}
                      </Text>
                    )}

                    <Stack gap={8}>
                      <Text size="sm" fw={600}>
                        Flag concerns
                      </Text>
                      <Group gap={8}>
                        {flagConcerns.map(({ label, icon: Icon }) => (
                          <Button
                            key={label}
                            variant="default"
                            size="xs"
                            radius="xl"
                            leftSection={<Icon size={14} />}
                            onClick={() => appendFlag(label)}
                          >
                            {label}
                          </Button>
                        ))}
                      </Group>
                    </Stack>
                  </Stack>
                </Group>

                {/* Actions */}
                <Group
                  justify="space-between"
                  wrap="nowrap"
                  pt="md"
                  gap="md"
                  style={{ borderTop: CREATOR_SHOP_BORDER }}
                  className="max-md:flex-wrap"
                >
                  <TextInput
                    placeholder="Add a note (required to reject or request changes)"
                    value={reason}
                    onChange={(e) => setReason(e.currentTarget.value)}
                    maxLength={1000}
                    style={{ flex: 1 }}
                    className="max-md:w-full"
                  />
                  <Group gap="sm" wrap="nowrap">
                    <Button variant="default" loading={reviewItem.isPending} onClick={handleReject}>
                      Request changes
                    </Button>
                    <Button
                      color="red"
                      variant="light"
                      leftSection={<IconX size={16} />}
                      loading={reviewItem.isPending}
                      onClick={handleReject}
                    >
                      Reject
                    </Button>
                    <Button
                      color="green"
                      leftSection={<IconCheck size={16} />}
                      loading={reviewItem.isPending}
                      onClick={handleApprove}
                    >
                      Approve &amp; Publish
                    </Button>
                  </Group>
                </Group>
              </Stack>
            ) : (
              <Center h="100%" py={80}>
                <Text c="dimmed">Select an item to review.</Text>
              </Center>
            )}
          </div>
        </Group>
      )}
    </Stack>
  );
}

export default Page(CreatorShopReviewPage);
