import {
  Anchor,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  MultiSelect,
  NumberInput,
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
  IconArrowBackUp,
  IconBolt,
  IconBox,
  IconCheck,
  IconCopyright,
  IconEyeOff,
  IconFilter,
  IconPhotoOff,
  IconScan,
  IconSearch,
  IconShieldCheck,
  IconSparkles,
  IconTag,
  IconTrendingUp,
  IconUsers,
  IconX,
} from '@tabler/icons-react';
import type { ComponentProps, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { NextLink } from '~/components/NextLink/NextLink';
import {
  useMutateCreatorShop,
  useQueryCreatorShopReviewQueue,
} from '~/components/CreatorShop/creator-shop.util';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { CheckRow, ChecksCard } from '~/components/CreatorShop/ChecksCard';
import { CosmeticThumb } from '~/components/CreatorShop/CosmeticThumb';
import { CREATOR_SHOP_BORDER } from '~/components/CreatorShop/creator-shop.constants';
import { cosmeticTypeOptions } from '~/components/CreatorShop/Submit/submit.constants';
import { CosmeticPreview } from '~/components/CosmeticShop/CosmeticPreview';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import type { CosmeticOffsets } from '~/server/schema/creator-shop.schema';
import {
  CREATOR_SHOP_CREATOR_SHARE,
  CREATOR_SHOP_SUBMISSION_FEE,
  DECORATION_OFFSET_LIMIT,
} from '~/server/schema/creator-shop.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { CosmeticShopItemStatus, CosmeticType } from '~/shared/utils/prisma/enums';
import { daysFromNow } from '~/utils/date-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';

type StatusFilter = CosmeticShopItemStatus | 'all';
type PreviewCosmetic = ComponentProps<typeof CosmeticPreview>['cosmetic'];

const statusFilterOptions: { label: string; value: StatusFilter }[] = [
  { label: 'Pending review', value: CosmeticShopItemStatus.PendingReview },
  { label: 'Changes requested', value: CosmeticShopItemStatus.RequestedChanges },
  { label: 'Published', value: CosmeticShopItemStatus.Published },
  { label: 'Rejected', value: CosmeticShopItemStatus.Rejected },
  { label: 'Archived', value: CosmeticShopItemStatus.Archived },
  { label: 'All statuses', value: 'all' },
];

// Label + badge color for an item's review status.
function statusMeta(status: CosmeticShopItemStatus): { label: string; color: string } {
  switch (status) {
    case CosmeticShopItemStatus.PendingReview:
      return { label: 'Pending', color: 'yellow' };
    case CosmeticShopItemStatus.RequestedChanges:
      return { label: 'Changes requested', color: 'orange' };
    case CosmeticShopItemStatus.Published:
      return { label: 'Approved', color: 'green' };
    case CosmeticShopItemStatus.Rejected:
      return { label: 'Rejected', color: 'red' };
    case CosmeticShopItemStatus.Archived:
      return { label: 'Archived', color: 'gray' };
    default:
      return { label: getDisplayName(status), color: 'gray' };
  }
}

// Quick-insert reasons a moderator can append to their note.
const flagConcerns = [
  { label: 'Copyright / IP', icon: IconCopyright },
  { label: 'Pricing', icon: IconTag },
  { label: 'Visual quality', icon: IconPhotoOff },
  { label: 'NSFW', icon: IconEyeOff },
];

const artUrl = (data: unknown) => (data as { url?: string } | null)?.url ?? null;

const ZERO_OFFSETS: CosmeticOffsets = { top: 0, right: 0, bottom: 0, left: 0 };

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

function DetailRow({ label, value, last }: { label: string; value: ReactNode; last?: boolean }) {
  return (
    <Group
      gap="md"
      align="flex-start"
      wrap="nowrap"
      px="md"
      py={9}
      style={last ? undefined : { borderBottom: CREATOR_SHOP_BORDER }}
    >
      <Text size="sm" c="dimmed" style={{ width: 120, flexShrink: 0 }}>
        {label}
      </Text>
      <div style={{ flex: 1, minWidth: 0 }}>{value}</div>
    </Group>
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
  const [typeFilter, setTypeFilter] = useState<CosmeticType[]>([]);
  // Creator filter: a searchable dropdown of real users — the queue filters by
  // the selected user's id. Typing an all-digits term looks the user up by id.
  const [creatorSearch, setCreatorSearch] = useState('');
  const [debouncedCreatorSearch] = useDebouncedValue(creatorSearch, 300);
  const [selectedCreator, setSelectedCreator] = useState<{ id: number; username: string } | null>(
    null
  );

  const creatorSearchTerm = debouncedCreatorSearch.trim();
  const creatorSearchId = /^\d+$/.test(creatorSearchTerm) ? Number(creatorSearchTerm) : undefined;
  const { data: userOptions, isFetching: searchingUsers } = trpc.user.getAll.useQuery(
    creatorSearchId
      ? { ids: [creatorSearchId], limit: 10 }
      : { query: creatorSearchTerm, limit: 10 },
    { enabled: !!currentUser?.isModerator && !!creatorSearchTerm }
  );
  const creatorOptions = useMemo(() => {
    const opts = (userOptions ?? [])
      .filter((u) => !!u.username)
      .map((u) => ({ value: String(u.id), label: u.username as string }));
    // Keep the current selection in the option list so its label stays visible
    // after the search results change.
    if (selectedCreator && !opts.some((o) => o.value === String(selectedCreator.id)))
      opts.unshift({ value: String(selectedCreator.id), label: selectedCreator.username });
    return opts;
  }, [userOptions, selectedCreator]);

  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useQueryCreatorShopReviewQueue({
      enabled: !!currentUser?.isModerator,
      status: statusFilter === 'all' ? undefined : statusFilter,
      userId: selectedCreator?.id,
      cosmeticTypes: typeFilter,
    });
  const { reviewItem } = useMutateCreatorShop();

  const items = useMemo(() => data?.pages.flatMap((p) => p.items) ?? [], [data]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [activeFlags, setActiveFlags] = useState<Set<string>>(() => new Set());
  const [modOffsets, setModOffsets] = useState<CosmeticOffsets>(ZERO_OFFSETS);

  useEffect(() => {
    setSelectedId((cur) => (cur && items.some((i) => i.id === cur) ? cur : items[0]?.id ?? null));
  }, [items]);

  // Load any existing review note + fit offsets when the selection changes.
  useEffect(() => {
    const item = items.find((i) => i.id === selectedId);
    setReason(item?.rejectionReason ?? '');
    setActiveFlags(new Set());
    setModOffsets(
      (item?.cosmetic.data as { offsets?: CosmeticOffsets } | null)?.offsets ?? ZERO_OFFSETS
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const selected = items.find((i) => i.id === selectedId) ?? null;
  const selectedMeta = (selected?.meta ?? {}) as CosmeticShopItemMeta;
  const checks = selectedMeta.autoChecks ?? [];
  const dims = selectedMeta.imageMeta;
  const isAnimated = !!(selected?.cosmetic.data as { animated?: boolean } | null)?.animated;

  // Fit adjustment (avatar decorations): mods can tweak the per-side pixel
  // offsets and see the in-context preview update live before saving.
  const isDecoration = selected?.cosmetic.type === CosmeticType.ProfileDecoration;
  const storedOffsets =
    (selected?.cosmetic.data as { offsets?: CosmeticOffsets } | null)?.offsets ?? null;
  const normalizedModOffsets = Object.values(modOffsets).some((v) => v !== 0) ? modOffsets : null;
  const fitChanged =
    isDecoration && JSON.stringify(normalizedModOffsets) !== JSON.stringify(storedOffsets);
  // The service treats offsets as a content change — blocked on published
  // (revert first) and archived items.
  const fitEditable =
    isDecoration &&
    selected?.status !== CosmeticShopItemStatus.Published &&
    selected?.status !== CosmeticShopItemStatus.Archived;

  const previewCosmetic = useMemo(() => {
    if (!selected) return null;
    if (!isDecoration) return selected.cosmetic as unknown as PreviewCosmetic;
    const { offsets: _stored, ...rest } = (selected.cosmetic.data ?? {}) as Record<string, unknown>;
    return {
      ...selected.cosmetic,
      data: normalizedModOffsets ? { ...rest, offsets: normalizedModOffsets } : rest,
    } as unknown as PreviewCosmetic;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, isDecoration, JSON.stringify(normalizedModOffsets)]);

  const queryUtils = trpc.useUtils();
  const saveFit = trpc.creatorShop.updateItem.useMutation({
    async onSuccess() {
      await queryUtils.creatorShop.getReviewQueue.invalidate();
    },
    onError: (error) =>
      showErrorNotification({ title: 'Failed to save fit', error: new Error(error.message) }),
  });

  if (currentUser && !currentUser.isModerator) return <NotFound />;

  // Flags toggle their label in/out of the note and light up while active, so a
  // moderator can't add the same concern twice.
  const toggleFlag = (label: string) =>
    setActiveFlags((prev) => {
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
        setReason((r) =>
          r
            .replace(label, '')
            .replace(/\s{2,}/g, ' ')
            .trim()
        );
      } else {
        next.add(label);
        setReason((r) => (r.trim() ? `${r.trim()} ${label}` : label));
      }
      return next;
    });

  const handleApprove = async () => {
    if (!selected) return;
    await reviewItem.mutateAsync({ id: selected.id, action: 'approve' });
    setReason('');
  };

  // Reject is terminal; request-changes lets the creator edit & resubmit;
  // revert unpublishes a live item back into the queue. All require a note so
  // the creator knows why.
  const submitReview = async (action: 'reject' | 'request-changes' | 'revert') => {
    if (!selected) return;
    if (!reason.trim())
      return showErrorNotification({
        title: 'A note is required',
        error: new Error('Add a note so the creator knows what to change.'),
      });
    await reviewItem.mutateAsync({
      id: selected.id,
      action,
      rejectionReason: reason.trim(),
    });
    setReason('');
  };

  const pendingCount = statusFilter === CosmeticShopItemStatus.PendingReview ? items.length : null;

  return (
    <Stack gap={0} className="w-full">
      {/* Topbar — sticky within the app shell's scroll container so the queue
          scrolls under it instead of pushing it off-screen. */}
      <Group
        justify="space-between"
        align="center"
        px="xl"
        py="md"
        className="sticky top-0 z-10"
        style={{ borderBottom: CREATOR_SHOP_BORDER, background: 'var(--mantine-color-body)' }}
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
            w={190}
            value={statusFilter}
            onChange={(v) => setStatusFilter((v as StatusFilter) ?? 'all')}
            data={statusFilterOptions}
            allowDeselect={false}
            leftSection={<IconFilter size={16} />}
            comboboxProps={{ withinPortal: true }}
          />
          <MultiSelect
            size="sm"
            w={230}
            data={cosmeticTypeOptions}
            value={typeFilter}
            onChange={(v) => setTypeFilter(v as CosmeticType[])}
            placeholder={typeFilter.length ? undefined : 'All types'}
            clearable
            comboboxProps={{ withinPortal: true }}
          />
          <Select
            size="sm"
            w={220}
            placeholder="Filter by creator"
            searchable
            clearable
            value={selectedCreator ? String(selectedCreator.id) : null}
            onChange={(v) => {
              if (!v) return setSelectedCreator(null);
              const opt = creatorOptions.find((o) => o.value === v);
              setSelectedCreator(opt ? { id: Number(v), username: opt.label } : null);
            }}
            searchValue={creatorSearch}
            onSearchChange={setCreatorSearch}
            data={creatorOptions}
            // Options already come filtered from the search endpoint — and an
            // id search would never match its username label.
            filter={({ options }) => options}
            nothingFoundMessage={
              searchingUsers
                ? 'Searching…'
                : creatorSearchTerm
                ? 'No users found'
                : 'Type a username or user id'
            }
            leftSection={<IconSearch size={16} />}
            comboboxProps={{ withinPortal: true }}
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
                      onClick={() => setSelectedId(item.id)}
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
                        <CosmeticThumb data={item.cosmetic.data} name={item.title} bare />
                        <Stack gap={2} className="min-w-0" style={{ flex: 1 }}>
                          <Text size="sm" fw={600} lineClamp={1}>
                            {item.title}
                          </Text>
                          <Text size="xs" c="dimmed" lineClamp={1}>
                            @{item.cosmetic.creator?.username ?? 'unknown'} ·{' '}
                            {getDisplayName(item.cosmetic.type)}
                          </Text>
                        </Stack>
                        {statusFilter === 'all' && (
                          <Badge
                            size="sm"
                            variant="light"
                            radius="sm"
                            color={statusMeta(item.status).color}
                          >
                            {statusMeta(item.status).label}
                          </Badge>
                        )}
                      </Group>
                    </UnstyledButton>
                  );
                })}
                {hasNextPage && (
                  <InViewLoader
                    loadFn={fetchNextPage}
                    loadCondition={!isFetchingNextPage}
                    className="flex justify-center py-3"
                  >
                    <Loader size="sm" />
                  </InViewLoader>
                )}
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
                    <Badge variant="light" radius="xl" color={statusMeta(selected.status).color}>
                      {statusMeta(selected.status).label}
                    </Badge>
                  </Group>
                  <Group gap={6} align="center">
                    <Text size="sm" c="dimmed">
                      Submitted by
                    </Text>
                    {selected.cosmetic.creator?.username ? (
                      <Anchor
                        component={NextLink}
                        href={`/user/${selected.cosmetic.creator.username}`}
                        target="_blank"
                        size="sm"
                        fw={600}
                      >
                        @{selected.cosmetic.creator.username}
                      </Anchor>
                    ) : (
                      <Text size="sm" fw={600}>
                        unknown
                      </Text>
                    )}
                    <Text size="sm" c="dimmed">
                      · {daysFromNow(selected.createdAt)}
                    </Text>
                  </Group>
                </Stack>

                <Group align="flex-start" gap="xl" wrap="nowrap" className="max-md:flex-wrap">
                  {/* Preview */}
                  <Stack gap={10} style={{ width: 420, flexShrink: 0 }} className="max-md:w-full">
                    <div
                      className="flex items-center justify-center overflow-hidden"
                      style={{
                        height: 320,
                        borderRadius: 8,
                        border: CREATOR_SHOP_BORDER,
                        background: 'linear-gradient(135deg, #1A1B1E, #101113)',
                      }}
                    >
                      {artUrl(selected.cosmetic.data) ? (
                        <EdgeMedia
                          src={artUrl(selected.cosmetic.data)!}
                          width={340}
                          alt={selected.title}
                          className="max-h-[300px] max-w-[85%] object-contain"
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
                      <Text size="sm" fw={600} mb={4}>
                        In-context preview
                      </Text>
                      <CosmeticPreview
                        cosmetic={
                          previewCosmetic ?? (selected.cosmetic as unknown as PreviewCosmetic)
                        }
                        hideHeader
                      />
                    </div>
                    {isDecoration && (
                      <Stack gap={6}>
                        <Text size="sm" fw={600}>
                          Fit adjustment
                        </Text>
                        <Text size="xs" c="dimmed">
                          Pixel offset per edge (−{DECORATION_OFFSET_LIMIT} to{' '}
                          {DECORATION_OFFSET_LIMIT}) — negative extends the frame outside the
                          avatar. The preview above updates live.
                        </Text>
                        <Group gap="xs" grow>
                          {(['top', 'bottom', 'left', 'right'] as const).map((side) => (
                            <NumberInput
                              key={side}
                              size="xs"
                              label={side.charAt(0).toUpperCase() + side.slice(1)}
                              min={-DECORATION_OFFSET_LIMIT}
                              max={DECORATION_OFFSET_LIMIT}
                              step={1}
                              allowDecimal={false}
                              suffix="px"
                              disabled={!fitEditable}
                              value={modOffsets[side]}
                              onChange={(v) =>
                                setModOffsets((prev) => ({
                                  ...prev,
                                  [side]:
                                    typeof v === 'number'
                                      ? Math.max(
                                          -DECORATION_OFFSET_LIMIT,
                                          Math.min(DECORATION_OFFSET_LIMIT, Math.round(v))
                                        )
                                      : 0,
                                }))
                              }
                            />
                          ))}
                        </Group>
                        {fitEditable ? (
                          <Button
                            size="compact-sm"
                            variant="light"
                            disabled={!fitChanged}
                            loading={saveFit.isPending}
                            onClick={() =>
                              saveFit.mutate({ id: selected.id, offsets: normalizedModOffsets })
                            }
                          >
                            Save fit
                          </Button>
                        ) : (
                          <Text size="xs" c="dimmed">
                            {selected.status === CosmeticShopItemStatus.Published
                              ? 'Revert this item to pending to adjust its fit.'
                              : 'Archived items cannot be adjusted.'}
                          </Text>
                        )}
                      </Stack>
                    )}
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
                      <MoneyTile
                        label="Resale by others"
                        value={
                          selectedMeta.sellableByOthers
                            ? `Allowed · seller keeps ${selectedMeta.sellerShare ?? 0}%`
                            : 'Owner only'
                        }
                        icon={<IconUsers size={14} />}
                        iconColor="var(--mantine-color-teal-5)"
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

                    <Stack gap={8}>
                      <Text size="sm" fw={600}>
                        Details
                      </Text>
                      <Paper withBorder radius="md">
                        <DetailRow
                          label="Cosmetic name"
                          value={
                            <Text size="sm" fw={500}>
                              {selected.cosmetic.name}
                            </Text>
                          }
                        />
                        <DetailRow
                          label="Description"
                          last
                          value={
                            <Text size="sm" c={selected.description?.trim() ? undefined : 'dimmed'}>
                              {selected.description?.trim() || 'No description provided.'}
                            </Text>
                          }
                        />
                      </Paper>
                    </Stack>

                    <Stack gap={8}>
                      <Text size="sm" fw={600}>
                        Flag concerns
                      </Text>
                      <Group gap={8}>
                        {flagConcerns.map(({ label, icon: Icon }) => {
                          const active = activeFlags.has(label);
                          return (
                            <Button
                              key={label}
                              variant={active ? 'filled' : 'default'}
                              color={active ? 'yellow' : undefined}
                              size="xs"
                              radius="xl"
                              leftSection={active ? <IconCheck size={14} /> : <Icon size={14} />}
                              onClick={() => toggleFlag(label)}
                            >
                              {label}
                            </Button>
                          );
                        })}
                      </Group>
                    </Stack>
                  </Stack>
                </Group>

                {/* Actions — archived items are view-only (reviewItem rejects them). */}
                {selected.status === CosmeticShopItemStatus.Archived ? (
                  <Group pt="md" style={{ borderTop: CREATOR_SHOP_BORDER }}>
                    <Text size="sm" c="dimmed">
                      This item is archived and can&apos;t be reviewed. The creator can restore it
                      from their shop&apos;s manage view.
                    </Text>
                  </Group>
                ) : (
                  <Group
                    justify="space-between"
                    wrap="nowrap"
                    pt="md"
                    gap="md"
                    style={{ borderTop: CREATOR_SHOP_BORDER }}
                    className="max-md:flex-wrap"
                  >
                    <TextInput
                      placeholder="Add a note (required for everything except approval)"
                      value={reason}
                      onChange={(e) => setReason(e.currentTarget.value)}
                      maxLength={1000}
                      style={{ flex: 1 }}
                      className="max-md:w-full"
                    />
                    <Group gap="sm" wrap="nowrap">
                      {selected.status === CosmeticShopItemStatus.Published && (
                        <Button
                          color="orange"
                          variant="light"
                          leftSection={<IconArrowBackUp size={16} />}
                          loading={reviewItem.isPending}
                          onClick={() => submitReview('revert')}
                        >
                          Revert to pending
                        </Button>
                      )}
                      <Button
                        variant="default"
                        loading={reviewItem.isPending}
                        onClick={() => submitReview('request-changes')}
                      >
                        Request changes
                      </Button>
                      <Button
                        color="red"
                        variant="light"
                        leftSection={<IconX size={16} />}
                        loading={reviewItem.isPending}
                        onClick={() => submitReview('reject')}
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
                )}
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
