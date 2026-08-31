import {
  Anchor,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  MultiSelect,
  NumberInput,
  Pagination,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  UnstyledButton,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconPackage,
  IconArrowBackUp,
  IconArrowsSort,
  IconBan,
  IconBolt,
  IconBox,
  IconCheck,
  IconCopyright,
  IconEyeOff,
  IconFilter,
  IconHexagonOff,
  IconPhotoOff,
  IconRepeat,
  IconScan,
  IconSearch,
  IconShieldCheck,
  IconSparkles,
  IconTag,
  IconTrash,
  IconTrendingUp,
  IconUsers,
  IconX,
} from '@tabler/icons-react';
import type { Icon as TablerIcon } from '@tabler/icons-react';
import { openConfirmModal } from '@mantine/modals';
import type { ComponentProps, ReactNode } from 'react';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { NextLink } from '~/components/NextLink/NextLink';
import {
  useMutateCreatorShop,
  useQueryCreatorShopReviewQueue,
  useQueryCreatorShopReviewQueueCreators,
} from '~/components/CreatorShop/creator-shop.util';
import { CheckRow, ChecksCard } from '~/components/CreatorShop/ChecksCard';
import { CosmeticThumb } from '~/components/CreatorShop/CosmeticThumb';
import { HistoryCard } from '~/components/CreatorShop/HistoryCard';
import { PriorReviewCard } from '~/components/CreatorShop/PriorReviewCard';
import { priorReviewFromHistory } from '~/components/CreatorShop/review-history';
import { SimilarArtworkCard } from '~/components/CreatorShop/SimilarArtworkCard';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import {
  CREATOR_SHOP_BORDER,
  submissionFeeLabel,
} from '~/components/CreatorShop/creator-shop.constants';
import {
  reviewQueueSortOptions,
  reviewQueueTypeOptions,
  type ReviewQueueFilterType,
} from '~/components/CreatorShop/Submit/submit.constants';
import type { ReviewQueueSort } from '~/server/schema/creator-shop.schema';
import { CosmeticPreview } from '~/components/CosmeticShop/CosmeticPreview';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import type { CosmeticOffsets } from '~/server/schema/creator-shop.schema';
import {
  CREATOR_SHOP_CREATOR_SHARE,
  DECORATION_OFFSET_LIMIT,
} from '~/server/schema/creator-shop.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { CosmeticShopItemStatus, CosmeticType } from '~/shared/utils/prisma/enums';
import { stickerEconomicsFromCosmeticData } from '~/shared/utils/sticker-token';
import { daysFromNow, formatDate } from '~/utils/date-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { showErrorNotification } from '~/utils/notifications';
import type { StatusFilter } from '~/components/CreatorShop/Submit/review-queue-query';
import {
  statusFromQuery,
  typesFromQuery,
} from '~/components/CreatorShop/Submit/review-queue-query';
import { PackContentsPanel } from '~/components/CreatorShop/Pack/PackContentsPanel';
import { PackCoverTiles } from '~/components/CreatorShop/Pack/PackCoverTiles';

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

// Quick-insert reasons a moderator can append to their note. A concern with a
// stock wording inserts that; the rest insert their bare label.
const flagConcerns: { label: string; icon: TablerIcon; note?: string }[] = [
  {
    label: 'Copyright / IP',
    icon: IconCopyright,
    note: 'Copyright / IP - We explicitly state "All cosmetics must ... not use copyrighted or trademarked material you don\'t own."',
  },
  {
    label: 'Hexagonal',
    icon: IconHexagonOff,
    note: 'Not hexagonal - please review the standards. If you fail to abide by them, I will reject this.',
  },
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

// Rendered above AND below the list: the Published queue is long enough that
// having to scroll back to either end to change page is the problem paging was
// added to solve.
function QueuePagination({
  page,
  totalPages,
  onChange,
  position,
}: {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
  position: 'top' | 'bottom';
}) {
  if (totalPages <= 1) return null;

  return (
    <Group
      justify="center"
      px="sm"
      py={8}
      style={
        position === 'top'
          ? { borderBottom: CREATOR_SHOP_BORDER }
          : { borderTop: CREATOR_SHOP_BORDER }
      }
    >
      {/* No siblings, tight gap — the column is 380px and the control has to
          survive a three-digit page count. */}
      <Pagination
        size="sm"
        gap={4}
        siblings={0}
        value={page}
        onChange={onChange}
        total={totalPages}
        withEdges
      />
    </Group>
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
  const router = useRouter();
  // Seeded from the URL once, then owned by this component. Not kept in sync
  // with `router.query` on every render: the page writes the query itself, and
  // two writers on one value is how a filter ends up fighting its own history
  // entry.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(
    () =>
      statusFromQuery(router.query.status, statusFilterOptions) ??
      CosmeticShopItemStatus.PendingReview
  );
  const [typeFilter, setTypeFilter] = useState<ReviewQueueFilterType[]>(() =>
    typesFromQuery(router.query.type)
  );
  const [selectedCreator, setSelectedCreator] = useState<{ id: number; username: string } | null>(
    null
  );
  const [sort, setSort] = useState<ReviewQueueSort>('oldest');
  const [page, setPage] = useState(1);

  const { creators, isLoading: loadingCreators } = useQueryCreatorShopReviewQueueCreators(
    !!currentUser?.isModerator
  );
  const creatorOptions = useMemo(
    () => creators.map((c) => ({ value: String(c.id), label: c.username })),
    [creators]
  );

  const { data, isLoading } = useQueryCreatorShopReviewQueue({
    enabled: !!currentUser?.isModerator,
    status: statusFilter === 'all' ? undefined : statusFilter,
    userId: selectedCreator?.id,
    cosmeticTypes: typeFilter,
    sort,
    page,
  });
  const { reviewItem, deleteItem, takedownItem } = useMutateCreatorShop();

  const items = useMemo(() => data?.items ?? [], [data]);
  const totalItems = data?.totalItems ?? 0;
  const totalPages = data?.totalPages ?? 1;

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [activeFlags, setActiveFlags] = useState<Set<string>>(() => new Set());
  const [modOffsets, setModOffsets] = useState<CosmeticOffsets>(ZERO_OFFSETS);

  const queueViewportRef = useRef<HTMLDivElement>(null);

  // Paging from the bottom control would otherwise leave the list scrolled to
  // the end, so the new page opens on its last few items.
  function goToPage(next: number) {
    setPage(next);
    queueViewportRef.current?.scrollTo({ top: 0 });
  }

  // Any change to what the queue holds invalidates the page number the
  // moderator is on, so every control that reshapes the list goes through this.
  function changeQuery(apply: () => void) {
    apply();
    goToPage(1);
  }

  // Mirror the two linkable filters back into the URL so the address bar is
  // always a link to what is on screen — shallow, so it never refetches the
  // page, and `replace` rather than `push` so narrowing a filter does not build
  // a back-button trail through every intermediate selection.
  useEffect(() => {
    // Everything this effect does NOT own is carried through untouched. Building
    // the query from scratch erased utm/ref params and anything else a link
    // arrived with — the shared `useZodRouteParams` merges for the same reason.
    const preserved = Object.entries(router.query).filter(
      ([key, value]) => typeof value === 'string' && key !== 'status' && key !== 'type'
    ) as [string, string][];

    const next: Record<string, string> = Object.fromEntries(preserved);
    if (statusFilter !== CosmeticShopItemStatus.PendingReview) next.status = statusFilter;
    if (typeFilter.length) next.type = typeFilter.join(',');

    // Sorted on both sides before comparing: `router.query` arrives in the
    // URL's key order and `next` in insertion order, so an unsorted compare
    // reported a difference for a pure reordering and fired one pointless
    // replace on arrival from the pre-filtered nav link.
    const render = (entries: [string, string][]) =>
      new URLSearchParams([...entries].sort(([a], [b]) => a.localeCompare(b))).toString();

    const current = render(
      Object.entries(router.query).flatMap(([key, value]) =>
        typeof value === 'string' ? [[key, value] as [string, string]] : []
      )
    );
    if (current === render(Object.entries(next))) return;

    router.replace({ pathname: router.pathname, query: next }, undefined, { shallow: true });
    // `router` is deliberately out of the deps — it changes identity on every
    // navigation, which would re-run this against its own write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, typeFilter]);

  /**
   * Which type tab is lit.
   *
   * Derived from `typeFilter` rather than held alongside it — the multi-select
   * can express things the tabs cannot (two types at once), and a second piece
   * of state would let the two disagree. Nothing is lit for a multi-type
   * selection, which is honest: no single tab describes it.
   */
  const activeTypeTab =
    typeFilter.length === 0 ? 'all' : typeFilter.length === 1 ? typeFilter[0] : null;

  useEffect(() => {
    setSelectedId((cur) => (cur && items.some((i) => i.id === cur) ? cur : items[0]?.id ?? null));
  }, [items]);

  // Reviewing items shrinks the queue, and the last page can disappear out from
  // under the moderator — leaving them on an empty page with no way back.
  useEffect(() => {
    if (!isLoading && page > totalPages) setPage(totalPages);
  }, [isLoading, page, totalPages]);

  // Load any existing review note + fit offsets when the selection changes.
  useEffect(() => {
    const item = items.find((i) => i.id === selectedId);
    setReason(item?.rejectionReason ?? '');
    setActiveFlags(new Set());
    setModOffsets(
      (item?.cosmetic?.data as { offsets?: CosmeticOffsets } | null)?.offsets ?? ZERO_OFFSETS
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const selected = items.find((i) => i.id === selectedId) ?? null;
  const isPack = !!selected && !selected.cosmetic;
  // A pack is authored by whoever listed it; a cosmetic by whoever made it.
  const submitter = selected?.cosmetic?.creator ?? selected?.addedBy ?? null;
  const selectedMeta = (selected?.meta ?? {}) as CosmeticShopItemMeta;
  // The verdict the item stopped carrying the moment the creator edited it.
  const priorReview = priorReviewFromHistory(selectedMeta.history);
  const checks = selectedMeta.autoChecks ?? [];
  const dims = selectedMeta.imageMeta;
  const isAnimated = !!(selected?.cosmetic?.data as { animated?: boolean } | null)?.animated;
  const affirmation = selectedMeta.rightsAffirmation;
  // The affirmer is normally the submitting creator, but a cross-listed item is
  // sold by someone else — don't put the creator's name on their affirmation.
  const affirmedBy =
    affirmation && affirmation.userId === (selected?.cosmetic?.creator?.id ?? selected?.addedBy?.id)
      ? `@${selected?.cosmetic?.creator?.username ?? selected?.addedBy?.username ?? 'unknown'}`
      : `user #${affirmation?.userId}`;
  // The slug is user-visible text in its own right, so it needs reviewing
  // alongside the artwork — not just the image.
  const isSticker = selected?.cosmetic?.type === CosmeticType.Sticker;
  const stickerSlug = isSticker
    ? (selected?.cosmetic?.data as { slug?: string } | null)?.slug
    : undefined;
  // A sticker is priced twice — the listing buys a block of uses, and the
  // per-use price is what a buyer pays to top up once they run dry. Reviewing
  // the list price alone approves half the economics.
  const stickerEconomics = isSticker
    ? stickerEconomicsFromCosmeticData(selected?.cosmetic?.data)
    : undefined;
  // What a use costs when bought in the listing, for comparison: a top-up
  // priced far above the bulk rate is the thing worth questioning, and it can
  // be changed after approval without re-entering review.
  const bulkRatePerUse =
    stickerEconomics?.uses && selected
      ? Math.floor(selected.unitAmount / stickerEconomics.uses)
      : undefined;

  // Fit adjustment (avatar decorations): mods can tweak the per-side pixel
  // offsets and see the in-context preview update live before saving.
  const isDecoration = selected?.cosmetic?.type === CosmeticType.ProfileDecoration;
  const storedOffsets =
    (selected?.cosmetic?.data as { offsets?: CosmeticOffsets } | null)?.offsets ?? null;
  const normalizedModOffsets = Object.values(modOffsets).some((v) => v !== 0) ? modOffsets : null;
  const fitChanged =
    isDecoration && JSON.stringify(normalizedModOffsets) !== JSON.stringify(storedOffsets);
  // Mods may adjust fit at any point, even post-publish; only archived items
  // are locked server-side.
  const fitEditable = isDecoration && selected?.status !== CosmeticShopItemStatus.Archived;

  const previewCosmetic = useMemo(() => {
    if (!selected) return null;
    if (!isDecoration) return selected.cosmetic as unknown as PreviewCosmetic;
    const { offsets: _stored, ...rest } = (selected.cosmetic?.data ?? {}) as Record<
      string,
      unknown
    >;
    return {
      ...selected.cosmetic,
      data: normalizedModOffsets ? { ...rest, offsets: normalizedModOffsets } : rest,
    } as unknown as PreviewCosmetic;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, isDecoration, JSON.stringify(normalizedModOffsets)]);

  const features = useFeatureFlags();
  // Lazy, per selection: the lookup reads every fingerprinted cosmetic, so it has
  // no business running for the whole queue when a mod is looking at one item.
  const similarQuery = trpc.creatorShop.getSimilarCosmetics.useQuery(
    { cosmeticId: selected?.cosmetic?.id as number },
    {
      enabled: features.cosmeticSimilarity && !!selected?.cosmetic?.id,
      // The repo default is `staleTime: Infinity`, which would make this answer
      // permanent for the session — including the "not fingerprinted yet, check
      // back in about 15 minutes" one, whose whole point is that coming back
      // works. It also has to re-run after a mod swaps the artwork.
      staleTime: 0,
      refetchOnMount: 'always',
    }
  );

  const queryUtils = trpc.useUtils();
  const saveFit = trpc.creatorShop.updateItem.useMutation({
    async onSuccess() {
      await queryUtils.creatorShop.getReviewQueue.invalidate();
    },
    onError: (error) =>
      showErrorNotification({ title: 'Failed to save fit', error: new Error(error.message) }),
  });

  if (currentUser && !currentUser.isModerator) return <NotFound />;

  // Flags toggle their text in/out of the note and light up while active, so a
  // moderator can't add the same concern twice.
  const toggleFlag = (concern: (typeof flagConcerns)[number]) =>
    setActiveFlags((prev) => {
      const { label } = concern;
      const text = concern.note ?? label;
      const next = new Set(prev);
      if (next.has(label)) {
        next.delete(label);
        setReason((r) =>
          r
            .replace(text, '')
            .replace(/\s{2,}/g, ' ')
            .trim()
        );
      } else {
        next.add(label);
        setReason((r) => (r.trim() ? `${r.trim()} ${text}` : text));
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

  // Same warning as the creator-side manage table: purchase records/totals are
  // lost, buyers keep their cosmetics, nothing is refunded.
  const confirmDelete = () => {
    if (!selected) return;
    const purchases = selected._count?.purchases ?? 0;
    openConfirmModal({
      title: 'Delete shop item',
      children: (
        <Stack gap="xs">
          <Text size="sm">
            Permanently delete <strong>{selected.title}</strong>? This can&apos;t be undone and
            removes it from every shop that lists it.
          </Text>
          {purchases > 0 && (
            <Text size="sm" c="red">
              This item has <strong>{numberWithCommas(purchases)}</strong> sale
              {purchases === 1 ? '' : 's'}. Its purchase records and sales totals will be
              permanently lost. Buyers keep the cosmetics they purchased — no refunds are issued.
            </Text>
          )}
        </Stack>
      ),
      labels: { confirm: 'Delete', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      centered: true,
      onConfirm: () => deleteItem.mutate({ id: selected.id }),
    });
  };

  // Takedown is the IP/TOS path: unlike Delete it refunds every buyer, reverses
  // the creator's earnings and strips the cosmetic from everyone who owns it.
  const confirmTakedown = () => {
    if (!selected) return;
    if (!reason.trim())
      return showErrorNotification({
        title: 'A note is required',
        error: new Error('Add the takedown reason — buyers and the creator both see it.'),
      });
    const purchases = selected._count?.purchases ?? 0;
    openConfirmModal({
      title: 'Take down shop item',
      children: (
        <Stack gap="xs">
          <Text size="sm">
            Remove <strong>{selected.title}</strong> from sale, refund all{' '}
            <strong>{numberWithCommas(purchases)}</strong> buyer{purchases === 1 ? '' : 's'}, take
            back the Buzz the seller was paid for those sales, and delete the cosmetic from every
            account that owns or has it equipped.
          </Text>
          <Text size="sm" c="dimmed">
            The creator&apos;s submission fee is not refunded. This can&apos;t be undone — the item
            can&apos;t be restored to sale afterwards.
          </Text>
        </Stack>
      ),
      labels: { confirm: 'Take down', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      centered: true,
      onConfirm: () => takedownItem.mutate({ id: selected.id, reason: reason.trim() }),
    });
  };

  const pendingCount = statusFilter === CosmeticShopItemStatus.PendingReview ? totalItems : null;

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
            onChange={(v) => changeQuery(() => setStatusFilter((v as StatusFilter) ?? 'all'))}
            data={statusFilterOptions}
            allowDeselect={false}
            leftSection={<IconFilter size={16} />}
            comboboxProps={{ withinPortal: true }}
          />
          {/* One visible click per type, because the multi-select alone left
              stickers indistinguishable from everything else in the queue —
              you had to know they were in there to narrow to them. The
              multi-select stays for the things tabs cannot say (two types at
              once); both write the same `typeFilter`. */}
          <SegmentedControl
            size="xs"
            value={activeTypeTab ?? ''}
            onChange={(v) =>
              changeQuery(() => setTypeFilter(v === 'all' ? [] : [v as ReviewQueueFilterType]))
            }
            data={[{ label: 'All', value: 'all' }, ...reviewQueueTypeOptions]}
          />
          <MultiSelect
            size="sm"
            w={230}
            data={reviewQueueTypeOptions}
            value={typeFilter}
            onChange={(v) => changeQuery(() => setTypeFilter(v as ReviewQueueFilterType[]))}
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
            onChange={(v) =>
              changeQuery(() => {
                if (!v) return setSelectedCreator(null);
                const opt = creatorOptions.find((o) => o.value === v);
                setSelectedCreator(opt ? { id: Number(v), username: opt.label } : null);
              })
            }
            data={creatorOptions}
            nothingFoundMessage={loadingCreators ? 'Loading…' : 'No creators found'}
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
          <div
            className="flex shrink-0 flex-col"
            style={{
              width: 380,
              height: 'calc(100vh - 160px)',
              borderRight: CREATOR_SHOP_BORDER,
            }}
          >
            <Group
              justify="space-between"
              align="center"
              gap="xs"
              wrap="nowrap"
              px="sm"
              py={8}
              style={{ borderBottom: CREATOR_SHOP_BORDER }}
            >
              <Select
                size="xs"
                w={150}
                value={sort}
                onChange={(v) => changeQuery(() => setSort((v as ReviewQueueSort) ?? 'oldest'))}
                data={reviewQueueSortOptions}
                allowDeselect={false}
                leftSection={<IconArrowsSort size={14} />}
                comboboxProps={{ withinPortal: true }}
              />
              <Text size="xs" c="dimmed" className="whitespace-nowrap">
                {numberWithCommas(totalItems)} {totalItems === 1 ? 'item' : 'items'}
              </Text>
            </Group>
            <QueuePagination
              page={page}
              totalPages={totalPages}
              onChange={goToPage}
              position="top"
            />
            <ScrollArea viewportRef={queueViewportRef} style={{ flex: 1, minHeight: 0 }}>
              <Stack gap={0}>
                {items.map((item) => {
                  const active = item.id === selectedId;
                  // The queue is ordered by submission date and says nothing
                  // about an item's history, so re-reviews need their own marker.
                  const itemPrior = priorReviewFromHistory(
                    ((item.meta ?? {}) as CosmeticShopItemMeta).history
                  );
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
                        {item.cosmetic ? (
                          <CosmeticThumb data={item.cosmetic.data} name={item.title} bare />
                        ) : (
                          <ThemeIcon variant="light" color="gray" size={44} radius="md">
                            <IconPackage size={22} />
                          </ThemeIcon>
                        )}
                        <Stack gap={2} className="min-w-0" style={{ flex: 1 }}>
                          <Text size="sm" fw={600} lineClamp={1}>
                            {item.title}
                          </Text>
                          <Text size="xs" c="dimmed" lineClamp={1}>
                            @
                            {item.cosmetic?.creator?.username ??
                              item.addedBy?.username ??
                              'unknown'}{' '}
                            · {item.cosmetic ? getDisplayName(item.cosmetic.type) : 'Pack'}
                          </Text>
                        </Stack>
                        {itemPrior && item.status === CosmeticShopItemStatus.PendingReview && (
                          <Badge
                            size="sm"
                            variant="light"
                            radius="sm"
                            color={itemPrior.artworkSwaps ? 'orange' : 'yellow'}
                          >
                            {itemPrior.artworkSwaps ? 'New artwork' : 'Re-review'}
                          </Badge>
                        )}
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
              </Stack>
            </ScrollArea>
            <QueuePagination
              page={page}
              totalPages={totalPages}
              onChange={goToPage}
              position="bottom"
            />
          </div>

          {/* Detail */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {selected ? (
              <Stack gap="lg" p="xl">
                <Stack gap={6}>
                  <Group gap={10} align="center" wrap="wrap">
                    <Title order={3}>{selected.title}</Title>
                    <Badge variant="light" color="gray" radius="xl">
                      {selected.cosmetic
                        ? `Cosmetic · ${getDisplayName(selected.cosmetic.type)}`
                        : 'Pack'}
                    </Badge>
                    <Badge variant="light" radius="xl" color={statusMeta(selected.status).color}>
                      {statusMeta(selected.status).label}
                    </Badge>
                  </Group>
                  {!selected.cosmetic && <PackContentsPanel shopItemId={selected.id} />}
                  <Group gap={6} align="center">
                    <Text size="sm" c="dimmed">
                      Submitted by
                    </Text>
                    {submitter?.username ? (
                      <Anchor
                        component={NextLink}
                        href={`/user/${submitter.username}`}
                        target="_blank"
                        size="sm"
                        fw={600}
                      >
                        @{submitter.username}
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

                {!!priorReview && <PriorReviewCard prior={priorReview} />}

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
                      {artUrl(selected.cosmetic?.data) ? (
                        <EdgeMedia
                          src={artUrl(selected.cosmetic?.data)!}
                          width={340}
                          alt={selected.title}
                          className="max-h-[300px] max-w-[85%] object-contain"
                        />
                      ) : selectedMeta.coverUrl ? (
                        <EdgeMedia
                          src={selectedMeta.coverUrl}
                          width={340}
                          alt={selected.title}
                          className="max-h-[300px] max-w-[85%] object-contain"
                        />
                      ) : isPack ? (
                        <PackCoverTiles
                          tiles={selectedMeta.coverTiles ?? []}
                          size={240}
                          fallbackIcon
                        />
                      ) : (
                        <Text size="sm" c="dimmed">
                          No artwork
                        </Text>
                      )}
                    </div>
                    <Text size="xs" c="dimmed" ta="center">
                      {selected.cosmetic
                        ? `Submitted artwork${dims ? ` · ${dims.width}×${dims.height} PNG` : ''}`
                        : selectedMeta.coverUrl
                        ? 'Pack cover'
                        : 'Pack contents — no cover was supplied'}
                    </Text>
                    {!!selected.cosmetic && (
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
                    )}
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
                            Archived items cannot be adjusted.
                          </Text>
                        )}
                      </Stack>
                    )}
                  </Stack>

                  {/* Meta */}
                  <Stack gap="md" style={{ flex: 1, minWidth: 0 }}>
                    {/* One grid, ordered so the pricing reads as a sequence:
                        what it costs, what that buys, what a refill costs, then
                        who gets what. Splitting it into rows made the sticker
                        fields look like a separate concern rather than the rest
                        of the same price. */}
                    <SimpleGrid cols={{ base: 1, xs: 3 }} spacing="sm">
                      <MoneyTile
                        label="List price"
                        value={`${numberWithCommas(selected.unitAmount)} Buzz`}
                        icon={<IconBolt size={14} />}
                        iconColor="var(--mantine-color-yellow-5)"
                      />
                      {isSticker && (
                        <>
                          <MoneyTile
                            label="Uses per purchase"
                            value={
                              stickerEconomics?.uses
                                ? `${numberWithCommas(stickerEconomics.uses)} placements${
                                    bulkRatePerUse
                                      ? ` · ${numberWithCommas(bulkRatePerUse)} Buzz each`
                                      : ''
                                  }`
                                : 'Not set — sells an unlimited balance'
                            }
                            icon={<IconRepeat size={14} />}
                            iconColor="var(--mantine-color-indigo-5)"
                          />
                          <MoneyTile
                            label="Price per extra use"
                            value={
                              stickerEconomics?.pricePerUse
                                ? `${numberWithCommas(stickerEconomics.pricePerUse)} Buzz${
                                    bulkRatePerUse && stickerEconomics.pricePerUse > bulkRatePerUse
                                      ? ` · ${(
                                          stickerEconomics.pricePerUse / bulkRatePerUse
                                        ).toFixed(1)}x the bulk rate`
                                      : ''
                                  }`
                                : 'Not set — cannot be topped up'
                            }
                            icon={<IconBolt size={14} />}
                            iconColor="var(--mantine-color-orange-5)"
                          />
                        </>
                      )}
                      <MoneyTile
                        // A pack's revenue splits per member creator, with only
                        // the residual reaching the lister — a single figure
                        // names money nobody receives.
                        label={isPack ? 'Creators earn (split)' : 'Creator earns'}
                        value={`${numberWithCommas(
                          Math.floor(selected.unitAmount * CREATOR_SHOP_CREATOR_SHARE)
                        )} Buzz${isPack ? ' across members' : ''}`}
                        icon={<IconTrendingUp size={14} />}
                        iconColor="var(--mantine-color-green-5)"
                      />
                      <MoneyTile
                        label="Submission fee"
                        value={submissionFeeLabel(selectedMeta.submissionFee)}
                        icon={<IconCheck size={14} />}
                        iconColor="var(--mantine-color-blue-5)"
                      />
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
                      {!isPack && (
                        <MoneyTile
                          label="Animated"
                          value={isAnimated ? 'Yes' : 'No'}
                          icon={<IconSparkles size={14} />}
                          iconColor="var(--mantine-color-pink-5)"
                        />
                      )}
                      <MoneyTile
                        label="Type"
                        value={selected.cosmetic ? getDisplayName(selected.cosmetic.type) : 'Pack'}
                        icon={<IconTag size={14} />}
                        iconColor="var(--mantine-color-cyan-5)"
                      />
                      {/* A pack cannot be resold by reference — the split is
                          computed from one cosmetic's creator and a pack has
                          several. */}
                      {!isPack && (
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
                      )}
                    </SimpleGrid>

                    <Stack gap={8}>
                      <Text size="sm" fw={600}>
                        Details
                      </Text>
                      <Paper withBorder radius="md">
                        {!isPack && (
                          <DetailRow
                            label="Cosmetic name"
                            value={
                              <Text size="sm" fw={500}>
                                {selected.cosmetic?.name}
                              </Text>
                            }
                          />
                        )}
                        {!!stickerSlug && (
                          <DetailRow
                            label="Slug"
                            value={
                              <Text size="sm" fw={500}>
                                :{stickerSlug}:
                              </Text>
                            }
                          />
                        )}
                        {(!isPack || !!affirmation) && (
                          <DetailRow
                            label="Rights affirmed"
                            value={
                              affirmation ? (
                                <Stack gap={2}>
                                  <Text size="sm">“{affirmation.statement}”</Text>
                                  <Text size="xs" c="dimmed">
                                    {affirmedBy} ·{' '}
                                    {formatDate(affirmation.affirmedAt, 'MMM D, YYYY h:mm A')} · v
                                    {affirmation.version}
                                  </Text>
                                </Stack>
                              ) : (
                                <Text size="sm" c="dimmed">
                                  Not recorded — submitted before this confirmation was required.
                                </Text>
                              )
                            }
                          />
                        )}
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
                        {flagConcerns.map((concern) => {
                          const { label, icon: Icon } = concern;
                          const active = activeFlags.has(label);
                          return (
                            <Button
                              key={label}
                              variant={active ? 'filled' : 'default'}
                              color={active ? 'yellow' : undefined}
                              size="xs"
                              radius="xl"
                              leftSection={active ? <IconCheck size={14} /> : <Icon size={14} />}
                              onClick={() => toggleFlag(concern)}
                            >
                              {label}
                            </Button>
                          );
                        })}
                      </Group>
                    </Stack>
                  </Stack>
                </Group>

                {/* Actions — archived items are view-only (reviewItem refuses
                    them). A rejected item keeps its buttons: this panel is the
                    only way back from a rejection, and it is moderator-only. */}
                {selected.status === CosmeticShopItemStatus.Archived ? (
                  <Group pt="md" style={{ borderTop: CREATOR_SHOP_BORDER }}>
                    <Text size="sm" c="dimmed">
                      This item is archived and can&apos;t be reviewed. The creator can restore it
                      from their shop&apos;s manage view.
                    </Text>
                  </Group>
                ) : (
                  <Stack gap={8} pt="md" style={{ borderTop: CREATOR_SHOP_BORDER }}>
                    {selected.status === CosmeticShopItemStatus.Rejected && (
                      <Text size="sm" c="dimmed">
                        Rejected — the creator can no longer edit, relist or restore this. Bringing
                        it back is a moderator action: request changes to hand it to them, or
                        approve to publish it as it stands.
                      </Text>
                    )}
                    <Group
                      justify="space-between"
                      wrap="nowrap"
                      gap="md"
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
                        {selected.status === CosmeticShopItemStatus.Published ? (
                          // Already-live items: review verdicts make no sense —
                          // the mod either pulls it back into the queue or removes it.
                          <>
                            <Button
                              color="orange"
                              variant="light"
                              leftSection={<IconArrowBackUp size={16} />}
                              loading={reviewItem.isPending}
                              onClick={() => submitReview('revert')}
                            >
                              Revert to pending
                            </Button>
                            <Button
                              color="red"
                              variant="light"
                              leftSection={<IconBan size={16} />}
                              loading={takedownItem.isPending}
                              onClick={confirmTakedown}
                            >
                              Take down
                            </Button>
                            <Button
                              color="red"
                              leftSection={<IconTrash size={16} />}
                              loading={deleteItem.isPending}
                              onClick={confirmDelete}
                            >
                              Delete
                            </Button>
                          </>
                        ) : (
                          <>
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
                          </>
                        )}
                      </Group>
                    </Group>
                  </Stack>
                )}

                {/* Supporting evidence, below the decision controls: it is only
                    occasionally relevant, and above them it pushed the verdict
                    off-screen behind a long scroll. */}
                <Stack gap="md" pt="md" style={{ borderTop: CREATOR_SHOP_BORDER }}>
                  <HistoryCard history={selectedMeta.history} creator={submitter} />

                  {/* Only when the flag is on: the query is disabled otherwise,
                      so an empty-state card would claim a comparison nobody ran. */}
                  {!isPack && features.cosmeticSimilarity && (
                    <SimilarArtworkCard
                      result={similarQuery.data}
                      isLoading={similarQuery.isLoading}
                      isError={similarQuery.isError}
                    />
                  )}

                  {/* A pack supplies no artwork to scan, so an empty checks
                      card reads as an anomaly rather than "not applicable". */}
                  {!isPack && (
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
                            {isPack
                              ? 'Packs have no artwork to scan — each member was checked when it was submitted.'
                              : 'No automated checks were recorded for this submission.'}
                          </Text>
                        </Group>
                      )}
                    </ChecksCard>
                  )}
                </Stack>
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
