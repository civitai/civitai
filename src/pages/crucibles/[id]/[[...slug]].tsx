import {
  Alert,
  Button,
  Container,
  Group,
  Paper,
  Progress,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { openConfirmModal, closeAllModals } from '@mantine/modals';
import type { InferGetServerSidePropsType } from 'next';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import * as z from 'zod';
import {
  IconGavel,
  IconUpload,
  IconBook,
  IconPencil,
  IconX,
  IconTrophy,
  IconSettings,
} from '@tabler/icons-react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import {
  getCrucibleRatings,
  getCrucibleTotalPrizePool,
  getCrucibleUrl,
  parsePrizePositions,
} from '~/utils/crucible-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';
import { env } from '~/env/client';
import { getModelUrl } from '~/utils/string-helpers';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { CrucibleHeader } from '~/components/Crucible/CrucibleHeader';
import { CrucibleLeaderboard } from '~/components/Crucible/CrucibleLeaderboard';
import { CrucibleEntryGrid } from '~/components/Crucible/CrucibleEntryGrid';
import { CrucibleEditModal } from '~/components/Crucible/CrucibleEditModal';
import { CruciblePodium } from '~/components/Crucible/CruciblePodium';
import { CruciblePrizeBreakdown } from '~/components/Crucible/CruciblePrizeBreakdown';
import { DescriptionTable } from '~/components/DescriptionTable/DescriptionTable';
import { crucibleRankingsAreFinal } from '~/shared/constants/crucible.constants';
import { CrucibleStatus, Currency, MediaType } from '~/shared/utils/prisma/enums';
import { abbreviateNumber } from '~/utils/number-helpers';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { Gated } from '~/components/Gated/Gated';
import { formatDate } from '~/utils/date-helpers';
import type { RouterOutput } from '~/types/router';
import { openCrucibleSubmitEntryModal } from '~/components/Dialog/triggers/crucible-submit-entry';
import { triggerRoutedDialog } from '~/components/Dialog/RoutedDialogLink';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { ImageSort } from '~/server/common/enums';
import type { ImageGetInfinite } from '~/types/router';
import { isDefined } from '~/utils/type-guards';
import { showSuccessNotification, showErrorNotification } from '~/utils/notifications';

const querySchema = z.object({
  id: z.coerce.number(),
  slug: z.array(z.string()).optional(),
});

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  resolver: async ({ ctx, ssg, features }) => {
    if (!features?.crucible) return { notFound: true };

    const result = querySchema.safeParse(ctx.query);
    if (!result.success) return { notFound: true };

    if (ssg) {
      await ssg.crucible.getById.prefetch({ id: result.data.id });
    }

    return { props: removeEmpty(result.data) };
  },
});

function CrucibleDetailPage({ id }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const browsingLevel = useBrowsingLevelDebounced();

  const { data: crucible, isLoading } = trpc.crucible.getById.useQuery({ id });
  const [entriesSeed] = useState(() => Math.floor(Math.random() * 2 ** 31));
  const [editOpened, setEditOpened] = useState(false);
  const {
    data: entriesData,
    hasNextPage: hasMoreEntries,
    isFetchingNextPage: isLoadingMoreEntries,
    fetchNextPage: loadMoreEntries,
  } = trpc.crucible.getEntries.useInfiniteQuery(
    { crucibleId: id, seed: entriesSeed },
    { getNextPageParam: (lastPage) => lastPage.nextCursor }
  );
  const { data: judgesData } = trpc.crucible.getJudgesCount.useQuery(
    { crucibleId: id },
    { enabled: !!id }
  );

  // `?submit=1` (from the featured hero's "Enter Competition") opens the submit modal once, and is
  // stripped first so a refresh or back-nav doesn't reopen it. Keyed by id because Next reuses this
  // component across detail-to-detail navigations.
  const submitDeepLinkHandledFor = useRef<number>();
  useEffect(() => {
    if (!crucible || submitDeepLinkHandledFor.current === crucible.id) return;
    submitDeepLinkHandledFor.current = crucible.id;
    if (!router.query.submit) return;

    const { submit, ...query } = router.query;
    router.replace({ pathname: router.pathname, query }, undefined, { shallow: true });

    const canSubmit =
      crucible.status === CrucibleStatus.Active &&
      !!currentUser &&
      currentUser.id !== crucible.userId &&
      crucible.viewerEntries.length < getMaxUserEntries(crucible);
    if (canSubmit) openCrucibleSubmitEntryModal(getSubmitEntryProps(crucible));
  }, [crucible, router, currentUser]);

  const cancelMutation = trpc.crucible.cancel.useMutation({
    onSuccess: (result) => {
      const refunds = `${
        result.refundedEntries
      } entries refunded (${result.totalRefunded.toLocaleString()} Buzz total).${
        result.refundedSeed > 0
          ? ` Seeded prize pool of ${result.refundedSeed.toLocaleString()} Buzz returned to the creator.`
          : ''
      }${
        result.alreadySettled > 0
          ? ` ${result.alreadySettled} refund(s) had already gone through on an earlier attempt, so no Buzz moved for those now.`
          : ''
      }`;

      // The status write lands before any refund is attempted, so the crucible is cancelled either
      // way and an unfinished refund is a warning about money, not a failed cancellation.
      if (result.failedRefunds.length > 0) {
        showErrorNotification({
          title: 'Cancelled, but some refunds did not go through',
          error: new Error(
            `${refunds} ${result.failedRefunds.length} refund(s) still owed — cancel again to retry.`
          ),
        });
      } else {
        showSuccessNotification({
          title: 'Crucible Cancelled',
          message: `Successfully cancelled. ${refunds}`,
        });
      }
      queryUtils.crucible.getById.invalidate({ id });
      queryUtils.crucible.getEntries.invalidate({ crucibleId: id });
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to cancel crucible',
        error: new Error(error.message),
      });
    },
  });

  if (isLoading) return <PageLoader />;
  if (!crucible) return <NotFound />;

  const judgesCount = judgesData?.count ?? 0;

  const prizePositions = parsePrizePositions(crucible.prizePositions);
  const entryCount = crucible._count?.entries ?? 0;
  const entryFeePool = crucible.entryFee * entryCount;
  const totalPrizePool = getCrucibleTotalPrizePool({
    entryFee: crucible.entryFee,
    entryCount,
    seededPrizePool: crucible.seededPrizePool,
  });
  const isActive = crucible.status === CrucibleStatus.Active;
  const isPending = crucible.status === CrucibleStatus.Pending;
  const isCreator = !!currentUser && currentUser.id === crucible.userId;
  const isOpen = isActive && (!crucible.endAt || new Date(crucible.endAt) > new Date());
  const canSubmitEntries = isOpen;
  const canJudge = isOpen;
  const rankingsVisible = crucibleRankingsAreFinal(crucible.status);

  const loadedEntries = entriesData?.pages.flatMap((page) => page.items) ?? [];
  const userEntries = crucible.viewerEntries;

  // The detail view pages through the list it is handed, so hand it the entries in grid
  // order: the viewer's own first, then everyone else's as loaded.
  const openEntry = async ({ imageId }: { imageId: number }) => {
    const gridOrder = [
      ...userEntries,
      ...loadedEntries.filter((entry) => entry.userId !== currentUser?.id),
    ].map((entry) => entry.imageId);
    const at = Math.max(0, gridOrder.indexOf(imageId));
    const nearby = gridOrder.slice(Math.max(0, at - 100), at + 100);

    let images: ImageGetInfinite | undefined;
    try {
      const { items } = await queryUtils.client.image.getInfinite.query({
        ids: nearby,
        limit: nearby.length,
        period: 'AllTime',
        sort: ImageSort.Newest,
        browsingLevel,
      });
      const byId = new Map(items.map((image) => [image.id, image]));
      images = nearby.map((id) => byId.get(id)).filter(isDefined);
    } catch {
      // Opening the single image still works; only prev/next is lost.
    }

    triggerRoutedDialog({
      name: 'imageDetail',
      state: { imageId, images: images?.some((x) => x.id === imageId) ? images : undefined },
    });
  };
  const userEntryCount = userEntries.length;
  const maxUserEntries = getMaxUserEntries(crucible);
  const userEntryProgress = (userEntryCount / maxUserEntries) * 100;
  const allEntriesUsed = !!currentUser && userEntryCount >= maxUserEntries;

  const allowedResources = Array.isArray(crucible.allowedResources)
    ? (crucible.allowedResources as number[])
    : [];

  // Moderator-only: check if crucible can be cancelled
  const isModerator = currentUser?.isModerator ?? false;
  const isFinished =
    crucible.status === CrucibleStatus.Completed || crucible.status === CrucibleStatus.Cancelled;
  const canCancel = (isModerator && !isFinished) || (isCreator && isPending);
  const canEdit =
    (isModerator && crucible.status !== CrucibleStatus.Cancelled) ||
    (isCreator && (isPending || isOpen));

  // Handle cancel action with confirmation dialog
  const handleCancelCrucible = () => {
    openConfirmModal({
      title: 'Cancel Crucible',
      children: (
        <Stack gap="sm">
          <Text size="sm">
            Are you sure you want to cancel this crucible? This action cannot be undone.
          </Text>
          <Text size="sm" c="dimmed">
            All entry fees ({entryCount} entries × {crucible.entryFee.toLocaleString()} Buzz ={' '}
            {entryFeePool.toLocaleString()} Buzz total) will be refunded to participants.
          </Text>
          {crucible.seededPrizePool > 0 && (
            <Text size="sm" c="dimmed">
              The seeded prize pool ({crucible.seededPrizePool.toLocaleString()} Buzz) will be
              returned to the creator.
            </Text>
          )}
        </Stack>
      ),
      centered: true,
      closeOnConfirm: false,
      labels: { cancel: 'Keep it', confirm: 'Cancel Crucible' },
      confirmProps: { color: 'red', loading: cancelMutation.isPending },
      onConfirm: async () => {
        try {
          await cancelMutation.mutateAsync({ id });
          closeAllModals();
        } catch {
          // Error handled by mutation onError callback
        }
      },
    });
  };

  return (
    <>
      <Gated
        contentNsfwLevel={crucible.nsfwLevel}
        meta={{
          title: `${crucible.name} | Civitai Crucible`,
          description: crucible.description ?? undefined,
          canonical: `${env.NEXT_PUBLIC_BASE_URL}${getCrucibleUrl(crucible.id, crucible.name)}`,
        }}
      >
        {/* Hero Section */}
        <CrucibleHeader
          className="-mt-3"
          crucible={{
            id: crucible.id,
            name: crucible.name,
            description: crucible.description,
            status: crucible.status,
            nsfwLevel: crucible.nsfwLevel,
            entryFee: crucible.entryFee,
            seededPrizePool: crucible.seededPrizePool,
            endAt: crucible.endAt,
            user: crucible.user,
            image: crucible.image,
            _count: crucible._count,
          }}
        />

        {crucible.status === CrucibleStatus.Completed && (
          <CruciblePodium
            entries={loadedEntries}
            prizePositions={prizePositions}
            entryCount={entryCount}
            totalPrizePool={totalPrizePool}
          />
        )}

        {/* Main Content */}
        <Container size="xl" className="py-8">
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_340px]">
            {/* Left Column - Main Content */}
            <div>
              {/* Stats Grid */}
              <div className="mb-6 grid grid-cols-3 gap-4">
                <StatBox value={entryCount.toString()} label="Entries" />
                <StatBox value={abbreviateNumber(judgesCount)} label="Judges" />
                <StatBox
                  value={crucible.endAt ? getTimeRemaining(crucible.endAt, crucible.status) : '-'}
                  label="Time Left"
                />
              </div>

              {/* CTA Button - Start Judging */}
              {canJudge && (
                <Button
                  size="xl"
                  fullWidth
                  leftSection={<IconGavel size={24} />}
                  className="mb-8"
                  styles={{
                    root: {
                      background: 'linear-gradient(135deg, #228be6 0%, #40c057 100%)',
                      boxShadow: '0 8px 24px rgba(34, 139, 230, 0.3)',
                      fontWeight: 600,
                      fontSize: '1.125rem',
                      padding: '1.25rem 2.5rem',
                      transition: 'all 300ms',
                      '&:hover': {
                        background: 'linear-gradient(135deg, #1c7ec0 0%, #37b24d 100%)',
                        transform: 'translateY(-2px)',
                        boxShadow: '0 12px 32px rgba(34, 139, 230, 0.4)',
                      },
                    },
                  }}
                  onClick={() => router.push(`/crucibles/${crucible.id}/judge`)}
                >
                  Start Judging Now
                </Button>
              )}

              {/* Entry Grid with User Entries section */}
              <CrucibleEntryGrid
                entries={loadedEntries.map(toGridEntry)}
                viewerEntries={userEntries.map(toGridEntry)}
                totalCount={entryCount}
                hasMore={!!hasMoreEntries}
                isLoadingMore={isLoadingMoreEntries}
                onLoadMore={loadMoreEntries}
                onEntryClick={openEntry}
                title="All Entries"
                showRanks={rankingsVisible}
                showUserEntries={!!currentUser}
                currentUserId={currentUser?.id}
                maxUserEntries={maxUserEntries}
              />
            </div>

            {/* Right Column - Sidebar */}
            <div className="flex flex-col gap-6">
              {/* Your Entries Panel */}
              {canSubmitEntries && (
                <Paper className="rounded-lg p-6" bg="dark.6">
                  <Title
                    order={5}
                    className="mb-4 flex items-center gap-2 uppercase tracking-wider text-white"
                  >
                    <IconPencil size={16} />
                    Your Entries
                  </Title>

                  {isCreator ? (
                    <Text size="sm" c="dimmed" className="mb-4">
                      You created this crucible, so you can&apos;t enter it. You can still judge it.
                    </Text>
                  ) : allEntriesUsed ? (
                    <Alert color="green" radius="md" className="mb-4">
                      You&apos;ve submitted all your entries. Good luck!
                    </Alert>
                  ) : (
                    <Button
                      variant="light"
                      fullWidth
                      leftSection={<IconUpload size={16} />}
                      className="mb-4"
                      onClick={() => openCrucibleSubmitEntryModal(getSubmitEntryProps(crucible))}
                      disabled={!currentUser}
                    >
                      Submit Entry
                    </Button>
                  )}

                  {!allEntriesUsed && (
                    <div className="mb-4 border-b border-[#373a40] pb-4">
                      <Text size="xs" c="dimmed" tt="uppercase" mb={4}>
                        Entry Fee
                      </Text>
                      <CurrencyBadge
                        currency={Currency.BUZZ}
                        unitAmount={crucible.entryFee}
                        size="md"
                        fw={600}
                      />
                    </div>
                  )}

                  {currentUser && (
                    <div>
                      <Text size="xs" c="dimmed" tt="uppercase" mb={4}>
                        Your Entries
                      </Text>
                      <Text size="sm" fw={600} c="white" mb={8}>
                        {userEntryCount} of {maxUserEntries} used
                      </Text>
                      <Progress
                        value={userEntryProgress}
                        size={6}
                        radius="sm"
                        styles={{
                          root: {
                            backgroundColor: 'rgba(201, 203, 207, 0.1)',
                          },
                          section: {
                            background: 'linear-gradient(90deg, #228be6 0%, #40c057 100%)',
                          },
                        }}
                      />
                    </div>
                  )}
                </Paper>
              )}

              {/* Prize Pool & Standings */}
              {rankingsVisible ? (
                <CrucibleLeaderboard
                  entries={loadedEntries.filter(hasScore)}
                  totalCount={entryCount}
                  hasMore={!!hasMoreEntries}
                  onLoadMore={loadMoreEntries}
                  prizePositions={prizePositions}
                  totalPrizePool={totalPrizePool}
                  awarded={crucible.status === CrucibleStatus.Completed}
                />
              ) : (
                <>
                  <CruciblePrizeBreakdown
                    prizePositions={prizePositions}
                    totalPrizePool={totalPrizePool}
                    entryFee={crucible.entryFee}
                  />
                  <YourStandingPanel entries={userEntries} hasAccount={!!currentUser} />
                </>
              )}

              <DescriptionTable
                title={
                  <Group gap="xs" p="xs">
                    <IconBook size={16} />
                    <Text size="md" fw={500}>
                      Rules & Requirements
                    </Text>
                  </Group>
                }
                labelWidth="40%"
                items={[
                  {
                    label: 'Accepted Entries',
                    value: crucible.contentType === MediaType.video ? 'Videos only' : 'Images only',
                  },
                  {
                    label: 'Content Levels',
                    value: <ContentLevelBadges nsfwLevel={crucible.nsfwLevel} />,
                  },
                  {
                    label: 'Starts',
                    value: crucible.startAt ? formatDate(crucible.startAt, undefined, true) : null,
                    visible: isPending && !!crucible.startAt,
                  },
                  {
                    label: 'Required Resources',
                    value: <RequiredResources versionIds={allowedResources} />,
                    visible: allowedResources.length > 0,
                  },
                  {
                    label: 'Deadline',
                    value: crucible.endAt ? formatDate(crucible.endAt, undefined, true) : null,
                    visible: !!crucible.endAt,
                  },
                  {
                    label: 'Max Entries Per User',
                    value: `${maxUserEntries} ${maxUserEntries === 1 ? 'entry' : 'entries'}`,
                  },
                  {
                    label: 'Total Entry Cap',
                    value: `${crucible.maxTotalEntries} max`,
                    visible: !!crucible.maxTotalEntries,
                  },
                  { label: 'Judging', value: 'Continuous & Live' },
                  { label: 'Tie-Breaking', value: 'Earlier entries rank higher' },
                ]}
              />

              {(canEdit || canCancel) && (
                <Paper className="rounded-lg p-6" bg="dark.6">
                  <Title
                    order={5}
                    className="mb-4 flex items-center gap-2 uppercase tracking-wider text-white"
                  >
                    <IconSettings size={16} />
                    Manage Crucible
                  </Title>

                  <Stack gap="sm">
                    {canEdit && (
                      <Button
                        variant="light"
                        fullWidth
                        leftSection={<IconPencil size={16} />}
                        onClick={() => setEditOpened(true)}
                      >
                        Edit name & description
                      </Button>
                    )}
                    {canCancel && (
                      <Button
                        variant="outline"
                        color="red"
                        fullWidth
                        leftSection={<IconX size={16} />}
                        onClick={handleCancelCrucible}
                        loading={cancelMutation.isPending}
                      >
                        Cancel Crucible
                      </Button>
                    )}
                  </Stack>

                  {canCancel && (
                    <Text size="xs" c="dimmed" mt="sm">
                      {isPending
                        ? 'Cancelling before it starts returns your setup fee and seeded prize pool.'
                        : 'Cancelling will refund all entry fees to participants.'}
                    </Text>
                  )}
                </Paper>
              )}

              <CrucibleEditModal
                crucible={crucible}
                opened={editOpened}
                onClose={() => setEditOpened(false)}
              />
            </div>
          </div>
        </Container>
      </Gated>
    </>
  );
}

type CrucibleEntry = RouterOutput['crucible']['getEntries']['items'][number];
type CrucibleDetail = NonNullable<RouterOutput['crucible']['getById']>;

const getMaxUserEntries = (crucible: CrucibleDetail) => crucible.entryLimit ?? 5;

const getSubmitEntryProps = (crucible: CrucibleDetail) => ({
  crucibleId: crucible.id,
  crucibleName: crucible.name,
  entryFee: crucible.entryFee,
  entryLimit: getMaxUserEntries(crucible),
  nsfwLevel: crucible.nsfwLevel,
  contentType: crucible.contentType,
  currentEntryCount: crucible.viewerEntries.length,
  maxClipSeconds: crucible.maxClipSeconds,
  requiresResources:
    Array.isArray(crucible.allowedResources) && crucible.allowedResources.length > 0,
});

const toGridEntry = (entry: CrucibleEntry) => ({
  ...entry,
  image: { ...entry.image, metadata: (entry.image.metadata as MixedObject) ?? null },
  user: { ...entry.user, deletedAt: null },
});

const hasScore = (entry: CrucibleEntry): entry is CrucibleEntry & { score: number } =>
  entry.score !== null;

// Helper components

function YourStandingPanel({
  entries,
  hasAccount,
}: {
  entries: CrucibleEntry[];
  hasAccount: boolean;
}) {
  const scored = entries.filter(hasScore);
  const bestScore = scored.length ? Math.max(...scored.map((e) => e.score)) : null;
  const positions = entries.map((e) => e.position).filter((p): p is number => p !== null);
  const bestPosition = positions.length ? Math.min(...positions) : null;

  return (
    <Paper className="rounded-lg p-6" bg="dark.6">
      <Title order={5} className="mb-4 flex items-center gap-2 uppercase tracking-wider text-white">
        <IconTrophy size={16} />
        Your Standing
      </Title>

      {entries.length === 0 ? (
        <Text size="sm" c="dimmed">
          {hasAccount
            ? 'Standings stay hidden while this crucible is running. Enter to see how yours is doing, and the full ranking is revealed when it ends.'
            : 'Standings stay hidden while this crucible is running. The full ranking is revealed when it ends.'}
        </Text>
      ) : (
        <Stack gap="sm">
          <div>
            <Text size="xs" c="dimmed" tt="uppercase" mb={4}>
              Best Position
            </Text>
            <Text size="sm" fw={600} c="white">
              {bestPosition !== null ? `#${bestPosition}` : 'Revealed when the crucible ends'}
            </Text>
          </div>
          <div>
            <Text size="xs" c="dimmed" tt="uppercase" mb={4}>
              Best Score
            </Text>
            <Text size="sm" fw={600} c="white">
              {bestScore !== null ? `${Math.round(bestScore)} pts` : '-'}
            </Text>
          </div>
          <Text size="xs" c="dimmed">
            Only you can see this. Everyone else&apos;s ranking is revealed when the crucible ends.
          </Text>
        </Stack>
      )}
    </Paper>
  );
}

function StatBox({ value, label }: { value: string; label: string }) {
  return (
    <Paper className="rounded-lg p-4 text-center" bg="dark.6">
      <Text className="text-2xl font-bold text-white">{value}</Text>
      <Text size="xs" c="dimmed" tt="uppercase" className="tracking-wider" mt={4}>
        {label}
      </Text>
    </Paper>
  );
}

function RequiredResources({ versionIds }: { versionIds: number[] }) {
  const { data: versions, isLoading } = trpc.modelVersion.getVersionsByIds.useQuery({
    ids: versionIds,
  });

  if (isLoading) return <>Loading…</>;
  if (!versions?.length) return <>{`${versionIds.length} specific models`}</>;

  return (
    <div className="flex flex-col gap-1">
      <Text size="xs" c="dimmed">
        At least one of:
      </Text>
      {versions.map((version) => (
        <Link
          key={version.id}
          href={getModelUrl({
            modelId: version.modelId,
            modelName: version.modelName,
            modelVersionId: version.id,
          })}
          target="_blank"
          className="text-blue-400 hover:underline"
        >
          {version.modelName} — {version.name}
        </Link>
      ))}
    </div>
  );
}

function ContentLevelBadges({ nsfwLevel }: { nsfwLevel: number }) {
  const levels = getCrucibleRatings(nsfwLevel);

  return (
    <div className="flex flex-wrap gap-2">
      {levels.map((level) => (
        <span
          key={level}
          className="rounded-full border border-blue-500/30 bg-blue-500/20 px-3 py-1 text-xs font-semibold text-blue-400"
        >
          {level}
        </span>
      ))}
    </div>
  );
}

function getTimeRemaining(endAt: Date, status: CrucibleStatus): string {
  if (status === CrucibleStatus.Completed || status === CrucibleStatus.Cancelled) {
    return 'Ended';
  }

  const now = new Date();
  const end = new Date(endAt);
  const diff = end.getTime() - now.getTime();

  if (diff <= 0) return 'Ended';

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
}

export default Page(CrucibleDetailPage);
