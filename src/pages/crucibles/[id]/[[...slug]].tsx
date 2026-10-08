import {
  Alert,
  Button,
  Container,
  Loader,
  Paper,
  Progress,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { openConfirmModal, closeAllModals } from '@mantine/modals';
import type { InferGetServerSidePropsType } from 'next';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import * as z from 'zod';
import {
  IconBrush,
  IconCube,
  IconUpload,
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
  CRUCIBLE_MIN_VOTES_PERCENT,
  getCrucibleCountdown,
  getCrucibleManageActions,
  getCrucibleRatingLabel,
  getCrucibleTotalPrizePool,
  getCrucibleUrl,
  getFreeEntriesLabel,
  getCrucibleEntryBuzzType,
  isCrucibleSfw,
  isFreeCrucibleEntry,
  parsePrizePositions,
  CRUCIBLE_PRIZE_BUZZ_TYPE,
  areCrucibleEntriesClosed,
  getCrucibleEntriesCloseAt,
} from '~/utils/crucible-helpers';
import { Flags } from '~/shared/utils/flags';
import type { CrucibleBuzzType } from '~/components/Crucible/crucible-create-form';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';
import { env } from '~/env/client';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { requiresEmailVerification } from '~/server/common/email-verification-gate';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { CrucibleHeader } from '~/components/Crucible/CrucibleHeader';
import { PrizeClaimBanner } from '~/components/Prize/PrizeClaimBanner';
import { CrucibleLeaderboard } from '~/components/Crucible/CrucibleLeaderboard';
import { CrucibleRulesPanel } from '~/components/Crucible/CrucibleRulesPanel';
import { CrucibleEntryGrid, type CrucibleEntryData } from '~/components/Crucible/CrucibleEntryGrid';
import { CruciblePodium } from '~/components/Crucible/CruciblePodium';
import {
  CrucibleCaughtUpNotice,
  CrucibleStartJudgingButton,
} from '~/components/Crucible/CrucibleStartJudgingButton';
import { CruciblePrizeBreakdown } from '~/components/Crucible/CruciblePrizeBreakdown';
import { EligibleModelsList } from '~/components/EligibleModels/EligibleModelsList';
import {
  CRUCIBLE_ENTRIES_CLOSED_MESSAGE,
  crucibleRankingsAreFinal,
} from '~/shared/constants/crucible.constants';
import {
  CrucibleIngestionStatus,
  CrucibleStatus,
  Currency,
  ImageIngestionStatus,
  MediaType,
  PrizeSourceType,
} from '~/shared/utils/prisma/enums';
import { numberWithCommas } from '~/utils/number-helpers';
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
import { generationGraphPanel } from '~/store/generation-graph.store';
import { generationFormStore } from '~/store/generation-form.store';

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
  const features = useFeatureFlags();
  const entryBuzzType = getCrucibleEntryBuzzType(!!features.isGreen);
  const queryUtils = trpc.useUtils();
  const browsingLevel = useBrowsingLevelDebounced();

  const { data: crucible, isLoading } = trpc.crucible.getById.useQuery({ id });
  const [entriesSeed] = useState(() => Math.floor(Math.random() * 2 ** 31));
  const {
    data: entriesData,
    hasNextPage: hasMoreEntries,
    isFetchingNextPage: isLoadingMoreEntries,
    fetchNextPage: loadMoreEntries,
  } = trpc.crucible.getEntries.useInfiniteQuery(
    { crucibleId: id, seed: entriesSeed, browsingLevel },
    { getNextPageParam: (lastPage) => lastPage.nextCursor }
  );
  const { data: judgesData } = trpc.crucible.getJudgesCount.useQuery(
    { crucibleId: id },
    { enabled: !!id }
  );
  // The global staleTime is Infinity; judging on the judge page changes this.
  const { data: judgingProgress } = trpc.crucible.getJudgingProgress.useQuery(
    { crucibleId: id, browsingLevel },
    {
      // Guarded procedure: a muted or unverified viewer gets FORBIDDEN.
      enabled:
        !!currentUser &&
        !currentUser.muted &&
        !requiresEmailVerification(currentUser) &&
        crucible?.status === CrucibleStatus.Active &&
        (!crucible.endAt || new Date(crucible.endAt) > new Date()),
      staleTime: 0,
      refetchOnMount: 'always',
    }
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
      !areCrucibleEntriesClosed(crucible) &&
      crucible.viewerEntryCount < getMaxUserEntries(crucible);
    if (canSubmit) openCrucibleSubmitEntryModal(getSubmitEntryProps(crucible, entryBuzzType));
  }, [crucible, router, currentUser, entryBuzzType]);

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

  const removeEntryMutation = trpc.crucible.removeEntry.useMutation({
    onSuccess: (result) => {
      showSuccessNotification({
        title: 'Entry removed',
        message: result.refundedAmount
          ? `${result.refundedAmount.toLocaleString()} Buzz refunded to the entrant.`
          : 'It was a free entry, so there was nothing to refund.',
      });
      queryUtils.crucible.getById.invalidate({ id });
      queryUtils.crucible.getEntries.invalidate({ crucibleId: id });
    },
    onError: (error) => {
      showErrorNotification({ title: 'Could not remove entry', error: new Error(error.message) });
    },
  });

  const withdrawEntryMutation = trpc.crucible.withdrawEntry.useMutation({
    onSuccess: () => {
      showSuccessNotification({
        title: 'Entry removed',
        message: 'Your entry slot is open again.',
      });
      queryUtils.crucible.getById.invalidate({ id });
      queryUtils.crucible.getEntries.invalidate({ crucibleId: id });
    },
    onError: (error) => {
      showErrorNotification({ title: 'Could not remove entry', error: new Error(error.message) });
    },
  });

  if (isLoading) return <PageLoader />;
  if (!crucible) return <NotFound />;

  const judgesCount = judgesData?.count ?? 0;

  const prizePositions = parsePrizePositions(crucible.prizePositions);
  const entryCount = crucible._count?.entries ?? 0;
  const { paidEntryCount } = crucible;
  const entryFeePool = crucible.entryFee * paidEntryCount;
  const totalPrizePool = getCrucibleTotalPrizePool({
    entryFee: crucible.entryFee,
    paidEntryCount,
    seededPrizePool: crucible.seededPrizePool,
  });
  const isActive = crucible.status === CrucibleStatus.Active;
  const isPending = crucible.status === CrucibleStatus.Pending;
  const isCreator = !!currentUser && currentUser.id === crucible.userId;
  const isOpen = isActive && (!crucible.endAt || new Date(crucible.endAt) > new Date());
  const canSubmitEntries = isOpen;
  const entriesClosed = areCrucibleEntriesClosed(crucible);
  const entriesCloseAt = crucible.entryCutoffPercent ? getCrucibleEntriesCloseAt(crucible) : null;
  const canJudge = isOpen;
  const rankingsVisible = crucibleRankingsAreFinal(crucible.status);

  const loadedEntries = entriesData?.pages.flatMap((page) => page.items) ?? [];
  const userEntries = crucible.viewerEntries;

  const openEntry = async ({ imageId }: { imageId: number }, gridOrder: number[]) => {
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
  const userEntryCount = crucible.viewerEntryCount;
  const maxUserEntries = getMaxUserEntries(crucible);
  const userEntryProgress = (userEntryCount / maxUserEntries) * 100;
  const allEntriesUsed = !!currentUser && userEntryCount >= maxUserEntries;
  const freeEntriesLabel = getFreeEntriesLabel({
    freeEntriesPerUser: crucible.freeEntriesPerUser,
    entryLimit: maxUserEntries,
  });
  const nextEntryFree = isFreeCrucibleEntry({
    entriesSoFar: crucible.viewerEntriesSoFar,
    freeEntriesPerUser: crucible.freeEntriesPerUser,
  });

  const allowedResources = Array.isArray(crucible.allowedResources)
    ? (crucible.allowedResources as number[])
    : [];

  const isModerator = currentUser?.isModerator ?? false;
  const isOffDomain = !!features.isGreen && !isCrucibleSfw(crucible) && !isCreator && !isModerator;
  const { canEdit, canCancel, canRemoveEntries } = getCrucibleManageActions({
    status: crucible.status,
    endAt: crucible.endAt,
    isCreator,
    isModerator,
  });

  const handleRemoveEntry = (entry: CrucibleEntryData) => {
    openConfirmModal({
      title: 'Remove entry',
      children: (
        <Text size="sm">
          Remove {entry.user.username ? `${entry.user.username}'s` : 'this'} entry? Any entry fee
          they paid is refunded, and they&apos;re told a moderator removed it. This can&apos;t be
          undone.
        </Text>
      ),
      centered: true,
      labels: { cancel: 'Keep it', confirm: 'Remove entry' },
      confirmProps: { color: 'red' },
      onConfirm: () => removeEntryMutation.mutate({ entryId: entry.id }),
    });
  };

  const handleWithdrawEntry = (entry: CrucibleEntryData) => {
    openConfirmModal({
      title: 'Remove your entry',
      children: (
        <Stack gap="sm">
          <Text size="sm">
            Remove this entry from the crucible? It leaves judging and its slot opens up again.
          </Text>
          <Text size="sm" fw={600}>
            {crucible.entryFee > 0
              ? `There are no refunds, and entering again in this slot costs the full ${crucible.entryFee.toLocaleString()} Buzz fee.`
              : "This can't be undone."}
          </Text>
        </Stack>
      ),
      centered: true,
      labels: { cancel: 'Keep it', confirm: 'Remove entry' },
      confirmProps: { color: 'red' },
      onConfirm: () => withdrawEntryMutation.mutate({ entryId: entry.id }),
    });
  };

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
            All entry fees ({numberWithCommas(paidEntryCount)} paid{' '}
            {paidEntryCount === 1 ? 'entry' : 'entries'} × {crucible.entryFee.toLocaleString()} Buzz
            = {entryFeePool.toLocaleString()} Buzz total) will be refunded to participants.
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
        nsfw={isOffDomain}
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
            buzzType: CRUCIBLE_PRIZE_BUZZ_TYPE,
            startAt: crucible.startAt,
            endAt: crucible.endAt,
            contentType: crucible.contentType,
            user: crucible.user,
            image: crucible.image,
            heroImage: crucible.heroImage,
            _count: crucible._count,
            paidEntryCount,
          }}
        />

        {crucible.status === CrucibleStatus.Completed && (
          <PrizeClaimBanner sourceType={PrizeSourceType.Crucible} sourceId={crucible.id} />
        )}

        {crucible.status === CrucibleStatus.Completed && (
          <CruciblePodium
            entries={entriesData?.pages[0]?.podium ?? []}
            prizeWinners={crucible.prizeWinners}
            buzzType={CRUCIBLE_PRIZE_BUZZ_TYPE}
          />
        )}

        {/* Main Content */}
        <Container size="xl" className="py-8">
          <CrucibleReviewNotice crucible={crucible} canManage={canEdit} />
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_340px]">
            {/* Left Column - Main Content */}
            <div>
              {/* Stats Grid */}
              <div className="mb-6 grid grid-cols-3 gap-4">
                <StatBox value={numberWithCommas(entryCount)} label="Entries" />
                <StatBox value={numberWithCommas(judgesCount)} label="Judges" />
                <StatBox {...countdownStat(crucible)} />
              </div>

              {/* CTA Button - Start Judging */}
              {canJudge &&
                (judgingProgress?.votesUsedUp ? (
                  <CrucibleCaughtUpNotice />
                ) : (
                  <CrucibleStartJudgingButton
                    onClick={() => router.push(`/crucibles/${crucible.id}/judge`)}
                  />
                ))}

              {/* Entry Grid with User Entries section */}
              <CrucibleEntryGrid
                entries={loadedEntries.map(toGridEntry)}
                viewerEntries={userEntries.map(toGridEntry)}
                totalCount={entryCount}
                hasMore={!!hasMoreEntries}
                isLoadingMore={isLoadingMoreEntries}
                onLoadMore={loadMoreEntries}
                onEntryClick={openEntry}
                status={crucible.status}
                onRemoveEntry={canRemoveEntries ? handleRemoveEntry : undefined}
                onWithdrawEntry={isOpen ? handleWithdrawEntry : undefined}
                title="All Entries"
                showRanks={rankingsVisible}
                completed={crucible.status === CrucibleStatus.Completed}
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
                  ) : entriesClosed ? (
                    <Alert color="gray" radius="md" className="mb-4">
                      {CRUCIBLE_ENTRIES_CLOSED_MESSAGE}
                    </Alert>
                  ) : allEntriesUsed ? (
                    <Alert color="green" radius="md" className="mb-4">
                      You&apos;ve submitted all your entries. Good luck!
                    </Alert>
                  ) : (
                    <Stack gap="xs" className="mb-4">
                      {!currentUser?.muted && (
                        <GenerateEntryButton
                          contentType={crucible.contentType}
                          requiredVersionIds={allowedResources}
                        />
                      )}
                      <Button
                        variant="light"
                        fullWidth
                        leftSection={<IconUpload size={16} />}
                        onClick={() =>
                          openCrucibleSubmitEntryModal(getSubmitEntryProps(crucible, entryBuzzType))
                        }
                        disabled={!currentUser}
                      >
                        Submit Entry
                      </Button>
                    </Stack>
                  )}

                  {!allEntriesUsed && (
                    <div className="mb-4 border-b border-[#373a40] pb-4">
                      <Text size="xs" c="dimmed" tt="uppercase" mb={4}>
                        Entry Fee
                      </Text>
                      {nextEntryFree ? (
                        <Text size="md" fw={600} c="green.4">
                          Free
                        </Text>
                      ) : (
                        <CurrencyBadge
                          currency={Currency.BUZZ}
                          type={entryBuzzType}
                          unitAmount={crucible.entryFee}
                          size="md"
                          fw={600}
                        />
                      )}
                      {freeEntriesLabel && (
                        <Text size="xs" c="dimmed" mt={4}>
                          {crucible.freeEntriesPerUser < maxUserEntries
                            ? `${freeEntriesLabel}, then ${crucible.entryFee.toLocaleString()} Buzz each`
                            : freeEntriesLabel}
                        </Text>
                      )}
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

              {allowedResources.length > 0 && (
                <EligibleModelsPanel
                  crucibleId={crucible.id}
                  versionIds={allowedResources}
                  onGenerate={
                    canSubmitEntries &&
                    !entriesClosed &&
                    !isCreator &&
                    !allEntriesUsed &&
                    !currentUser?.muted
                      ? (versionId) => openCrucibleGenerator(crucible.contentType, [versionId])
                      : undefined
                  }
                />
              )}

              {/* Prize Pool & Standings */}
              {rankingsVisible ? (
                <CrucibleLeaderboard
                  entries={loadedEntries.filter(hasScore)}
                  totalCount={entryCount}
                  prizeWinners={crucible.prizeWinners}
                  hasMore={!!hasMoreEntries}
                  onLoadMore={loadMoreEntries}
                  prizePositions={prizePositions}
                  totalPrizePool={totalPrizePool}
                  buzzType={CRUCIBLE_PRIZE_BUZZ_TYPE}
                  awarded={crucible.status === CrucibleStatus.Completed}
                />
              ) : (
                <>
                  <CruciblePrizeBreakdown
                    prizePositions={prizePositions}
                    totalPrizePool={totalPrizePool}
                    entryFee={crucible.entryFee}
                    hasFreeEntries={crucible.freeEntriesPerUser > 0}
                    buzzType={CRUCIBLE_PRIZE_BUZZ_TYPE}
                  />
                  <YourStandingPanel entries={userEntries} hasAccount={!!currentUser} />
                </>
              )}

              <CrucibleRulesPanel
                rules={[
                  {
                    label: 'Entries Per Person',
                    value: `${maxUserEntries} ${maxUserEntries === 1 ? 'entry' : 'entries'}`,
                  },
                  {
                    label: 'Free Entries',
                    value: freeEntriesLabel ?? '',
                    visible: !!freeEntriesLabel,
                  },
                  {
                    label: 'Base Model',
                    value: `Made with a ${crucible.allowedBaseModels.join(' or ')} checkpoint`,
                    visible: crucible.allowedBaseModels.length > 0,
                  },
                  {
                    label: 'Total Entry Cap',
                    value: `${numberWithCommas(crucible.maxTotalEntries ?? 0)} entries`,
                    visible: !!crucible.maxTotalEntries,
                  },
                  {
                    label: 'Entries Close',
                    value: entriesCloseAt
                      ? `${formatDate(entriesCloseAt, 'MMM D [at] h:mm A')}, in the last ${
                          crucible.entryCutoffPercent
                        }% of the run`
                      : '',
                    visible: !!entriesCloseAt,
                  },
                  {
                    label: 'Max Clip Length',
                    value: `${crucible.maxClipSeconds}s`,
                    visible: crucible.contentType === MediaType.video && !!crucible.maxClipSeconds,
                  },
                  {
                    label: 'Watch Before Voting',
                    value: `Judges watch at least ${crucible.minViewSeconds}s of each clip`,
                    visible: crucible.contentType === MediaType.video && !!crucible.minViewSeconds,
                  },
                  {
                    label: 'Minimum Votes',
                    value: `${CRUCIBLE_MIN_VOTES_PERCENT}% of the average entry's votes to place`,
                  },
                  { label: 'Ties', value: 'The earlier entry ranks higher' },
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
                        component={Link}
                        href={`/crucibles/${crucible.id}/edit`}
                        variant="light"
                        fullWidth
                        leftSection={<IconPencil size={16} />}
                      >
                        Edit Crucible
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

const getSubmitEntryProps = (crucible: CrucibleDetail, entryBuzzType: CrucibleBuzzType) => ({
  crucibleId: crucible.id,
  crucibleName: crucible.name,
  entryFee: crucible.entryFee,
  buzzType: entryBuzzType,
  entryLimit: getMaxUserEntries(crucible),
  freeEntriesPerUser: crucible.freeEntriesPerUser,
  nsfwLevel: crucible.nsfwLevel,
  contentType: crucible.contentType,
  currentEntryCount: crucible.viewerEntryCount,
  entriesSoFar: crucible.viewerEntriesSoFar,
  maxClipSeconds: crucible.maxClipSeconds,
  requiresResources:
    Array.isArray(crucible.allowedResources) && crucible.allowedResources.length > 0,
  allowedBaseModels: crucible.allowedBaseModels,
  startAt: crucible.startAt,
  endAt: crucible.endAt,
  entryWarningPercent: crucible.entryWarningPercent,
  entryCutoffPercent: crucible.entryCutoffPercent,
});

// Required resources are alternatives ("at least one of"), so only the first is preselected.
function openCrucibleGenerator(contentType: MediaType, modelVersionIds: number[]) {
  if (modelVersionIds.length) {
    generationGraphPanel.open({ type: 'modelVersions', ids: modelVersionIds.slice(0, 1) });
  } else {
    generationGraphPanel.open();
  }
  generationFormStore.setType(contentType);
}

/** Only the creator and moderators can open a crucible that hasn't passed review. */
function CrucibleReviewNotice({
  crucible,
  canManage,
}: {
  crucible: CrucibleDetail;
  canManage: boolean;
}) {
  if (crucible.ingestion === CrucibleIngestionStatus.Blocked)
    return (
      <Alert color="red" radius="md" className="mb-6">
        This crucible is hidden because its text violates our Terms of Service.
      </Alert>
    );
  if (
    crucible.ingestion === CrucibleIngestionStatus.Scanned &&
    crucible.image?.ingestion === ImageIngestionStatus.Scanned
  ) {
    const coverLevel = crucible.image.nsfwLevel;
    if (!canManage || Flags.intersects(coverLevel, crucible.nsfwLevel)) return null;
    return (
      <Alert color="yellow" radius="md" className="mb-6">
        The cover is rated {getCrucibleRatingLabel(coverLevel)}, outside this crucible&apos;s
        content levels ({getCrucibleRatingLabel(crucible.nsfwLevel)}), so people browsing at those
        levels won&apos;t see it in the feed. Change the cover to list it for them.
      </Alert>
    );
  }
  return (
    <Alert color="yellow" radius="md" className="mb-6">
      We&apos;re reviewing this crucible&apos;s text and images. It&apos;s hidden from everyone else
      until that&apos;s done, usually within a few minutes.
    </Alert>
  );
}

function useGeneratableVersionIds(versionIds: number[]) {
  const { data: resources } = trpc.generation.getResourceDataByIds.useQuery(
    { ids: versionIds },
    { enabled: versionIds.length > 0 }
  );
  return new Set(
    resources
      ?.filter((resource) => resource.canGenerate || resource.substitute?.canGenerate)
      .map((resource) => resource.id)
  );
}

/** Hidden when the crucible requires models and none of them can generate for this viewer. */
function GenerateEntryButton({
  contentType,
  requiredVersionIds,
}: {
  contentType: MediaType;
  requiredVersionIds: number[];
}) {
  const generatable = useGeneratableVersionIds(requiredVersionIds);
  const generatableIds = requiredVersionIds.filter((id) => generatable.has(id));
  if (requiredVersionIds.length > 0 && !generatableIds.length) return null;

  return (
    <Button
      variant="filled"
      fullWidth
      leftSection={<IconBrush size={16} />}
      onClick={() => openCrucibleGenerator(contentType, generatableIds)}
    >
      Generate an entry
    </Button>
  );
}

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

function StatBox({ value, label, tooltip }: { value: string; label: string; tooltip?: string }) {
  return (
    <Tooltip label={tooltip} disabled={!tooltip} withArrow>
      <Paper className="rounded-lg p-4 text-center" bg="dark.6">
        <Text className="text-2xl font-bold text-white">{value}</Text>
        <Text size="xs" c="dimmed" tt="uppercase" className="tracking-wider" mt={4}>
          {label}
        </Text>
      </Paper>
    </Tooltip>
  );
}

const countdownStat = (crucible: Pick<CrucibleDetail, 'status' | 'startAt' | 'endAt'>) => {
  const { label, value, at } = getCrucibleCountdown(crucible);
  return {
    label,
    value,
    tooltip: at
      ? `${label === 'Starts In' ? 'Starts' : 'Ends'} ${formatDate(at, 'MMM D, YYYY h:mm A')}`
      : undefined,
  };
};

function EligibleModelsPanel({
  crucibleId,
  versionIds,
  onGenerate,
}: {
  crucibleId: number;
  versionIds: number[];
  onGenerate?: (versionId: number) => void;
}) {
  const browsingLevel = useBrowsingLevelDebounced();
  const { data: models = [], isLoading } = trpc.crucible.getRequiredModels.useQuery({
    id: crucibleId,
    browsingLevel,
  });
  const generatable = useGeneratableVersionIds(versionIds);
  const missing = isLoading ? 0 : versionIds.length - models.length;

  return (
    <Paper className="rounded-lg px-3 py-6" bg="dark.6">
      <Title
        order={5}
        className="mb-1 flex items-center gap-2 px-3 uppercase tracking-wider text-white"
      >
        <IconCube size={16} />
        Eligible Models
      </Title>
      <Text size="xs" c="dimmed" className="mb-3 px-3">
        Entries must be made with at least one of these.
      </Text>
      {isLoading ? (
        <Loader size="sm" className="mx-3" />
      ) : (
        <EligibleModelsList
          models={models}
          onGenerate={onGenerate ? (m) => onGenerate(m.versionId) : undefined}
          canGenerate={(m) => generatable.has(m.versionId)}
        />
      )}
      {missing > 0 && (
        <Text size="xs" c="dimmed" className="mt-2 px-3">
          {missing} required {missing === 1 ? 'model is' : 'models are'} no longer available.
        </Text>
      )}
    </Paper>
  );
}

export default Page(CrucibleDetailPage);
