import {
  ActionIcon,
  Alert,
  Button,
  Container,
  Group,
  Loader,
  Menu,
  Popover,
  Text,
  Title,
} from '@mantine/core';
import { useReducedMotion } from '@mantine/hooks';
import { keepPreviousData } from '@tanstack/react-query';
import { LazyMotion } from 'motion/react';
import { div as MotionDiv } from 'motion/react-m';
import type { InferGetServerSidePropsType } from 'next';
import Link from 'next/link';
import * as z from 'zod';
import {
  IconAlertCircle,
  IconArrowLeft,
  IconArrowsShuffle,
  IconClock,
  IconHourglass,
  IconInfoCircle,
  IconRefresh,
  IconUsers,
} from '@tabler/icons-react';
import { useState, useCallback, useEffect, useRef } from 'react';
import clsx from 'clsx';
import { v4 as uuidv4 } from 'uuid';
import { NotFound } from '~/components/AppLayout/NotFound';
import { AppLayout } from '~/components/AppLayout/AppLayout';
import { Page } from '~/components/AppLayout/Page';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';
import { env } from '~/env/client';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { CrucibleContentBadges } from '~/components/Crucible/CrucibleContentBadges';
import { CrucibleJudgeNextButton } from '~/components/Crucible/CrucibleJudgeNextButton';
import { CrucibleJudgeScoreRequired } from '~/components/Crucible/CrucibleJudgeScoreRequired';
import { CrucibleJudgeStreak } from '~/components/Crucible/CrucibleJudgeStreak';
import { CrucibleJudgingDoneState } from '~/components/Crucible/CrucibleJudgingDoneState';
import { CrucibleJudgingUI } from '~/components/Crucible/CrucibleJudgingUI';
import { useJudgeSkipList } from '~/components/Crucible/judge-skip-list';
import { CrucibleJudgingBriefing } from '~/components/Crucible/CrucibleJudgingBriefing';
import { hasSeenBriefing, markBriefingSeen } from '~/components/Crucible/judging-briefing';
import { JUDGING_RULES } from '~/components/Crucible/judging-rules';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import type { JudgingPairData, WatchedMs } from '~/components/Crucible/CrucibleJudgingUI';
import { CRUCIBLE_JUDGE_SCORE_REQUIRED_MESSAGE } from '~/shared/constants/crucible.constants';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import { getCrucibleUrl, isCrucibleSfw } from '~/utils/crucible-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { showErrorNotification, showInfoNotification } from '~/utils/notifications';
import { removeTags } from '~/utils/string-helpers';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';

const querySchema = z.object({
  id: z.coerce.number(),
});

// getJudgingPair and submitVote refuse with these once a crucible stops taking votes, which can
// happen while its status still reads Active (it lags until the finalize job runs).
const closedCrucibleMessages = [
  'This crucible has ended',
  'This crucible is not currently active for judging',
];
const isClosedCrucibleError = (message?: string) =>
  !!message && closedCrucibleMessages.includes(message);

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

function CrucibleJudgePage({ id }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const browsingLevel = useBrowsingLevelDebounced();

  // Session stats
  const [sessionVotes, setSessionVotes] = useState(0);
  const [currentStreak, setCurrentStreak] = useState(0); // Consecutive votes without skip
  const [streakResetAt, setStreakResetAt] = useState(0);
  const [isVoting, setIsVoting] = useState(false);
  const [allPairsJudged, setAllPairsJudged] = useState(false);
  const [closedByServer, setClosedByServer] = useState(false);
  const [refusedForScore, setRefusedForScore] = useState(false);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [lastVoteAttempt, setLastVoteAttempt] = useState<{
    winnerId: number;
    loserId: number;
    watched: WatchedMs;
  } | null>(null);

  const { skippedPairs, skip, recordVote } = useJudgeSkipList();
  // One judging session per visit to this page: leaving and coming back means watching in full again.
  const [judgingSessionId] = useState(uuidv4);

  // Read after mount: localStorage doesn't exist during server rendering.
  const [briefingOpen, setBriefingOpen] = useState(false);
  useEffect(() => {
    setBriefingOpen(!hasSeenBriefing(id, window.localStorage));
  }, [id]);
  const dismissBriefing = useCallback(() => {
    markBriefingSeen(id, window.localStorage);
    setBriefingOpen(false);
  }, [id]);
  // A ref rather than the attribute: React 18 has no `inert` prop. A callback ref, because the
  // arena mounts after the crucible loads, later than the briefing state is first read.
  const arenaRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) el.inert = briefingOpen;
    },
    [briefingOpen]
  );

  // Held in state rather than derived during render: `new Date()` differs between the server and
  // the client, so deriving it inline is a hydration mismatch.
  const [timeRemaining, setTimeRemaining] = useState<string | null>(null);
  const [hasEnded, setHasEnded] = useState(false);

  // Fetch crucible details
  const { data: crucible, isLoading: isLoadingCrucible } = trpc.crucible.getById.useQuery({ id });
  const { data: judgeEligibility } = trpc.crucible.getJudgeEligibility.useQuery(undefined, {
    enabled: !!currentUser,
  });

  const entryCount = crucible?._count?.entries ?? 0;
  // A judge is never shown their own entries.
  const judgeableEntryCount = entryCount - (crucible?.viewerEntries.length ?? 0);
  const canRequestPairs =
    !!currentUser &&
    crucible?.status === CrucibleStatus.Active &&
    judgeableEntryCount >= 2 &&
    !hasEnded &&
    !closedByServer &&
    judgeEligibility?.canJudge !== false &&
    !refusedForScore;

  const {
    data: pairData,
    isLoading: isLoadingPair,
    isFetching: isFetchingPair,
    isPlaceholderData: isPairPlaceholder,
    error: pairError,
    refetch: refetchPair,
  } = trpc.crucible.getJudgingPair.useQuery(
    {
      crucibleId: id,
      browsingLevel,
      skippedPairs: skippedPairs.length > 0 ? skippedPairs : undefined,
      judgingSessionId,
    },
    {
      enabled: canRequestPairs,
      refetchOnWindowFocus: false,
      // A skip list can recur once a vote takes an entry off it. Its cached pair is stale
      // (staleTime is Infinity app-wide), so nothing is kept once the input moves on.
      gcTime: 0,
      // A skip changes the input, and a new input has no data: without this the arena dropped to
      // its skeleton on every skip. The old pair stays up, locked, as it does while a vote lands.
      // Its `data` is the old pair, never the new result, so the null check below still holds.
      placeholderData: keepPreviousData,
    }
  );
  const isPairPending = isLoadingPair || isPairPlaceholder;

  // Refreshed after each vote, which also picks up entries that arrived meanwhile.
  const { data: progress, refetch: refetchProgress } = trpc.crucible.getJudgingProgress.useQuery(
    { crucibleId: id, browsingLevel },
    { enabled: canRequestPairs, refetchOnWindowFocus: false }
  );

  // Fetch judge stats for this user
  const { data: judgeStats } = trpc.crucible.getJudgeStats.useQuery(
    { crucibleId: id },
    {
      enabled: !!currentUser,
      refetchOnWindowFocus: false,
      staleTime: 30000, // Cache for 30 seconds
    }
  );

  // Submit vote mutation
  const submitVoteMutation = trpc.crucible.submitVote.useMutation({
    onError: (error) => {
      // Check if it's a network error
      const isNetworkError =
        error.message.includes('fetch') ||
        error.message.includes('network') ||
        error.message.includes('Failed to fetch') ||
        error.message.includes('NetworkError') ||
        error.message.includes('timeout');

      if (isClosedCrucibleError(error.message)) {
        setClosedByServer(true);
      } else if (error.message === CRUCIBLE_JUDGE_SCORE_REQUIRED_MESSAGE) {
        setRefusedForScore(true);
      } else if (isNetworkError) {
        setVoteError('Network error. Please check your connection and try again.');
      } else if (
        error.message.includes('already voted') ||
        error.message.includes('already being processed') ||
        error.message.includes('no longer available')
      ) {
        // Race condition - silently fetch next pair
        setVoteError(null);
        refetchPair();
      } else if (error.message.includes('Watch at least')) {
        // The session idled out while this pair was open, so its shortened watch no longer holds.
        showErrorNotification({ error: new Error(error.message) });
        refetchPair();
      } else {
        showErrorNotification({ error: new Error(error.message) });
      }
      setIsVoting(false);
    },
  });

  // Transform pair data to match component types
  const pair: JudgingPairData = pairData
    ? {
        left: {
          id: pairData.left.id,
          imageId: pairData.left.imageId,
          userId: pairData.left.userId,
          image: pairData.left.image,
          user: {
            id: pairData.left.user.id,
            username: pairData.left.user.username,
            deletedAt: pairData.left.user.deletedAt,
            image: pairData.left.user.image,
          },
        },
        right: {
          id: pairData.right.id,
          imageId: pairData.right.imageId,
          userId: pairData.right.userId,
          image: pairData.right.image,
          user: {
            id: pairData.right.user.id,
            username: pairData.right.user.username,
            deletedAt: pairData.right.user.deletedAt,
            image: pairData.right.user.image,
          },
        },
        watchSeconds: pairData.watchSeconds,
      }
    : null;

  // The server serves a skipped pair again only when no other pair is left, and a skip whose list
  // didn't move fetches nothing, so without this the judge sees Skip count up and nothing change.
  const pairKey = pair ? [pair.left.id, pair.right.id].sort((a, b) => a - b).join(':') : null;
  const [skippedPairKey, setSkippedPairKey] = useState<string | null>(null);
  const onlyPairLeft = !isFetchingPair && pairKey !== null && pairKey === skippedPairKey;
  useEffect(() => {
    if (onlyPairLeft) showOnlyPairLeftNotification();
  }, [onlyPairLeft]);

  // State lags a render behind, and a vote that lands meanwhile claims an already-claimed pair.
  const votingRef = useRef(false);
  const handleVote = useCallback(
    async (winnerId: number, loserId: number, watched: WatchedMs) => {
      if (votingRef.current || !pair) return;

      votingRef.current = true;
      setIsVoting(true);
      setVoteError(null);
      setLastVoteAttempt({ winnerId, loserId, watched });

      try {
        await submitVoteMutation.mutateAsync({
          crucibleId: id,
          winnerEntryId: winnerId,
          loserEntryId: loserId,
          ...watched,
          judgingSessionId,
        });

        setSessionVotes((prev) => prev + 1);
        setCurrentStreak((prev) => prev + 1); // Increment streak on vote
        setLastVoteAttempt(null);
        refetchProgress();
        if (!recordVote(pair)) {
          const result = await refetchPair();
          // Only an explicit null means no pairs are left; a failed refetch leaves `data` undefined.
          if (result.data === null) {
            // The done screen's copy depends on whether this vote used up the judge's last pair.
            await refetchProgress();
            setAllPairsJudged(true);
          }
        }
      } catch {
        // Reported by the mutation's onError.
      } finally {
        votingRef.current = false;
        setIsVoting(false);
      }
    },
    [pair, id, submitVoteMutation, refetchPair, refetchProgress, recordVote, judgingSessionId]
  );

  // Retry last vote attempt
  const handleRetryVote = useCallback(() => {
    if (lastVoteAttempt && !isVoting) {
      handleVote(lastVoteAttempt.winnerId, lastVoteAttempt.loserId, lastVoteAttempt.watched);
    }
  }, [lastVoteAttempt, isVoting, handleVote]);

  // Changing the excluded ids changes the query input, which fetches the next pair on its own.
  // Awaiting a `refetch()` here instead resolved with the NEW input's still-empty result, which
  // read as "no pairs left" and ended the session on every skip.
  const handleSkip = useCallback(
    ({ unavailable }: { unavailable: boolean }) => {
      if (isVoting || isPairPending || !pair) return;
      if (onlyPairLeft) return showOnlyPairLeftNotification();

      if (!unavailable && currentStreak > 0) {
        setCurrentStreak(0);
        setStreakResetAt((prev) => prev + 1);
      }
      setSkippedPairKey(pairKey);
      skip(pair);
    },
    [isVoting, isPairPending, pair, pairKey, onlyPairLeft, skip, currentStreak]
  );

  // Check if all pairs judged on initial load
  useEffect(() => {
    if (currentUser && !isLoadingPair && pairData === null) {
      setAllPairsJudged(true);
    }
  }, [currentUser, isLoadingPair, pairData]);

  const endAt = crucible?.endAt;
  useEffect(() => {
    if (!endAt) return;

    const tick = () => {
      setTimeRemaining(getTimeRemaining(endAt));
      setHasEnded(new Date(endAt).getTime() <= Date.now());
    };
    tick();
    const interval = setInterval(tick, 60000);

    return () => clearInterval(interval);
  }, [endAt]);

  // Loading state
  if (isLoadingCrucible) return <PageLoader />;
  if (!crucible) return <NotFound />;
  if (
    features.isGreen &&
    !isCrucibleSfw(crucible) &&
    !currentUser?.isModerator &&
    currentUser?.id !== crucible.userId
  )
    return <NotFound />;

  // Check if user is logged in
  if (!currentUser) {
    return (
      <LoginRedirect reason="judge-crucible">
        <Container size="lg" className="py-16 text-center">
          <Title order={2} mb="md">
            Sign in to Judge
          </Title>
          <Text c="dimmed" mb="xl">
            You need to be signed in to participate in crucible judging.
          </Text>
          <Button component={Link} href={`/login?returnUrl=/crucibles/${id}/judge`}>
            Sign In
          </Button>
        </Container>
      </LoginRedirect>
    );
  }

  const isActive = crucible.status === CrucibleStatus.Active;
  const isOver =
    crucible.status === CrucibleStatus.Completed ||
    hasEnded ||
    closedByServer ||
    isClosedCrucibleError(pairError?.message);
  if (!isActive || isOver) {
    return (
      <Container size="lg" className="py-16 text-center">
        {isOver && <IconClock className="mx-auto mb-4 size-16 text-gray-500" />}
        <Title order={2} mb="md">
          {isOver ? 'This crucible has ended' : 'Judging Not Available'}
        </Title>
        <Text c="dimmed" mb="xl">
          {isOver
            ? 'Judging is closed. The final results will appear on the crucible page.'
            : 'This crucible is not currently accepting votes.'}
        </Text>
        <Button component={Link} href={getCrucibleUrl(id, crucible.name)}>
          Back to Crucible
        </Button>
      </Container>
    );
  }

  if (
    judgeEligibility?.canJudge === false ||
    refusedForScore ||
    pairError?.message === CRUCIBLE_JUDGE_SCORE_REQUIRED_MESSAGE
  ) {
    return (
      <CrucibleJudgeScoreRequired
        score={judgeEligibility?.score}
        backHref={getCrucibleUrl(id, crucible.name)}
      />
    );
  }

  // Check if there are enough entries to judge (need at least 2)
  if (entryCount < 2) {
    return (
      <Container size="lg" className="py-16 text-center">
        <IconUsers className="mx-auto mb-4 size-16 text-gray-500" />
        <Title order={2} mb="md">
          Not Enough Entries Yet
        </Title>
        <Text c="dimmed" mb="xl" maw={400} className="mx-auto">
          This crucible needs at least 2 entries before judging can begin.
          {entryCount === 0
            ? ' Be the first to submit an entry!'
            : ' Check back soon or submit your own entry!'}
        </Text>
        <Group justify="center">
          <Button component={Link} href={getCrucibleUrl(id, crucible.name)}>
            Back to Crucible
          </Button>
        </Group>
      </Container>
    );
  }

  const onlyOwnEntries = judgeableEntryCount < 2;
  const showDoneState = allPairsJudged || onlyOwnEntries;
  const theme = crucible.description ? removeTags(crucible.description).trim() : '';

  return (
    <>
      <Meta
        title={`Judging: ${crucible.name} | Civitai Crucible`}
        description={`Help judge ${crucible.name} - vote on image pairs to determine the winner.`}
        canonical={`${env.NEXT_PUBLIC_BASE_URL}/crucibles/${crucible.id}/judge`}
      />

      <div className="-mt-3 flex h-[calc(100%+0.75rem)] flex-col overflow-y-auto md:overflow-hidden">
        <div className="shrink-0 pb-1 pt-2.5">
          <Container size="xl">
            <div
              data-judge-chrome
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
            >
              <div className="flex min-w-0 flex-1 items-center gap-3 max-md:gap-2">
                <ActionIcon
                  component={Link}
                  href={getCrucibleUrl(id, crucible.name)}
                  variant="subtle"
                  color="gray"
                  size="lg"
                  aria-label="Back to crucible"
                >
                  <IconArrowLeft size={20} />
                </ActionIcon>
                {crucible.image && (
                  <div className="size-11 shrink-0 overflow-hidden rounded-lg bg-[#2C2E33] max-md:size-9">
                    <EdgeMedia
                      src={crucible.image.url}
                      name={crucible.image.name}
                      type="image"
                      width={96}
                      className="size-full object-cover"
                    />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-col gap-1 md:flex-row md:flex-wrap md:items-center md:gap-x-3">
                    <h1 className="min-w-0 max-w-full truncate text-lg font-bold leading-tight text-white">
                      {crucible.name}
                    </h1>
                    <CrucibleContentBadges
                      className="max-md:hidden"
                      contentType={crucible.contentType}
                      nsfwLevel={crucible.nsfwLevel}
                    />
                    <CrucibleContentBadges
                      className="md:hidden"
                      contentType={crucible.contentType}
                      nsfwLevel={crucible.nsfwLevel}
                      compact
                    />
                  </div>
                  {theme && (
                    <Text size="xs" c="dimmed" lineClamp={1} className="[overflow-wrap:anywhere]">
                      {theme}
                    </Text>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1 max-md:gap-0.5">
                <JudgingRulesButton />
                <SwitchCrucibleMenu crucibleId={id} />
                <CrucibleJudgeNextButton
                  cycleFrom={{ id, createdAt: crucible.createdAt }}
                  variant="link"
                  label="Next crucible"
                />
              </div>
            </div>
          </Container>
        </div>

        <Container size="xl" className="flex w-full flex-1 flex-col pb-4 pt-1 md:min-h-0">
          {voteError && (
            <Alert
              icon={<IconAlertCircle size={18} />}
              title="Connection Error"
              color="red"
              mb="sm"
              withCloseButton
              onClose={() => setVoteError(null)}
            >
              <Group justify="space-between" align="center">
                <Text size="sm">{voteError}</Text>
                {lastVoteAttempt && (
                  <Button
                    size="xs"
                    variant="light"
                    color="red"
                    leftSection={<IconRefresh size={14} />}
                    onClick={handleRetryVote}
                    loading={isVoting}
                  >
                    Retry Vote
                  </Button>
                )}
              </Group>
            </Alert>
          )}

          {showDoneState ? (
            <div className="overflow-y-auto">
              <CrucibleJudgingDoneState
                crucibleId={id}
                crucibleName={crucible.name}
                crucibleCreatedAt={crucible.createdAt}
                sessionVotes={sessionVotes}
                onlyOwnEntries={onlyOwnEntries}
                votesUsedUp={progress?.votesUsedUp ?? false}
              />
            </div>
          ) : pairError ? (
            <Alert
              icon={<IconAlertCircle size={18} />}
              title="Couldn't load the next pair"
              color="red"
            >
              <Group justify="space-between" align="center">
                <Text size="sm">{pairError.message}</Text>
                <Button
                  size="xs"
                  variant="light"
                  color="red"
                  leftSection={<IconRefresh size={14} />}
                  onClick={() => refetchPair()}
                  loading={isFetchingPair}
                >
                  Try again
                </Button>
              </Group>
            </Alert>
          ) : (
            <div className="relative flex flex-1 flex-col md:min-h-0">
              <div ref={arenaRef} className="flex flex-1 flex-col md:min-h-0">
                <CrucibleJudgingUI
                  className={clsx(
                    'flex-1 md:min-h-0',
                    briefingOpen && 'pointer-events-none select-none opacity-25'
                  )}
                  pair={pair}
                  paused={briefingOpen}
                  isLoading={isPairPending || isVoting}
                  disabled={isVoting || isPairPlaceholder || !!voteError}
                  minViewSeconds={crucible.minViewSeconds}
                  onVote={handleVote}
                  onSkip={handleSkip}
                  footerStart={
                    <JudgingSessionStats
                      sessionVotes={sessionVotes}
                      totalPairsRated={(judgeStats?.totalPairsRated ?? 0) + sessionVotes}
                      percentileRank={judgeStats?.percentileRank}
                      judgedPairs={progress?.judgedPairs}
                      remainingPairs={progress?.remainingPairs}
                    />
                  }
                  footerEnd={
                    <div className="flex flex-col items-start gap-1.5 md:items-end">
                      {timeRemaining && (
                        <span className="inline-flex items-center gap-1 text-xs text-[#909296]">
                          <IconHourglass size={14} />
                          Ends in {timeRemaining}
                        </span>
                      )}
                      <CrucibleJudgeStreak streak={currentStreak} resetAt={streakResetAt} />
                    </div>
                  }
                />
              </div>
              {briefingOpen && (
                <CrucibleJudgingBriefing
                  name={crucible.name}
                  theme={theme}
                  image={crucible.image}
                  contentType={crucible.contentType}
                  nsfwLevel={crucible.nsfwLevel}
                  browsingLevel={browsingLevel}
                  onDismiss={dismissBriefing}
                />
              )}
            </div>
          )}
        </Container>
      </div>
    </>
  );
}

const loadMotion = () => import('~/utils/lazy-motion').then((res) => res.default);

const showOnlyPairLeftNotification = () =>
  showInfoNotification({
    id: 'crucible-only-pair-left',
    title: 'This is the only pair left for you',
    message:
      "You've judged or skipped everything else. Vote on it, or come back when new entries arrive.",
    autoClose: 5000,
  });

function JudgingRulesButton() {
  return (
    <Popover width={300} position="bottom-end" withArrow withinPortal shadow="md">
      <Popover.Target>
        <Button
          variant="subtle"
          color="gray"
          size="compact-sm"
          aria-label="Rules"
          className="max-md:px-1.5"
        >
          <span className="flex items-center gap-1.5">
            <IconInfoCircle size={16} />
            <span className="max-md:hidden">Rules</span>
          </span>
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Text size="sm" fw={600} mb={6}>
          How judging works
        </Text>
        <ol className="flex list-decimal flex-col gap-1 pl-4 text-sm text-[#c1c2c5]">
          {JUDGING_RULES.map((rule) => (
            <li key={rule}>{rule}</li>
          ))}
        </ol>
      </Popover.Dropdown>
    </Popover>
  );
}

function SwitchCrucibleMenu({ crucibleId }: { crucibleId: number }) {
  const browsingLevel = useBrowsingLevelDebounced();
  // Fetched on first open: most judges never open this menu.
  const [requested, setRequested] = useState(false);
  const { data, isLoading } = trpc.crucible.getJudgingSuggestions.useQuery(
    // Over-fetched: hidden preferences filter client-side, and 4 could all be hidden.
    { excludeCrucibleId: crucibleId, browsingLevel, limit: 12 },
    { enabled: requested, refetchOnWindowFocus: false }
  );
  const suggestions = useApplyHiddenPreferences({ type: 'crucibles', data }).items.slice(0, 4);

  return (
    <Menu
      position="bottom-end"
      width={320}
      withinPortal
      // The fixed width alone still overflows a phone. The label is a flex box, which ignores
      // text-overflow, so the name ellipsizes in its own span.
      classNames={{ dropdown: 'max-w-[calc(100vw-32px)]', itemLabel: 'min-w-0' }}
      onOpen={() => setRequested(true)}
    >
      <Menu.Target>
        <Button
          variant="subtle"
          color="gray"
          size="compact-sm"
          aria-label="Switch crucible"
          className="max-md:px-1.5"
        >
          <span className="flex items-center gap-1.5">
            <IconArrowsShuffle size={16} />
            <span className="max-md:hidden">Switch</span>
          </span>
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {isLoading ? (
          <div className="flex justify-center py-3">
            <Loader size="sm" />
          </div>
        ) : suggestions.length === 0 ? (
          <Text size="sm" c="dimmed" px="sm" py="xs">
            No other crucibles have pairs for you
          </Text>
        ) : (
          suggestions.map((c) => (
            <Menu.Item key={c.id} component={Link} href={`/crucibles/${c.id}/judge`} title={c.name}>
              <span className="block truncate">{c.name}</span>
            </Menu.Item>
          ))
        )}
      </Menu.Dropdown>
    </Menu>
  );
}

type JudgingSessionStatsProps = {
  sessionVotes: number;
  totalPairsRated: number;
  percentileRank?: number | null;
  judgedPairs?: number;
  remainingPairs?: number;
};

function JudgingSessionStats({
  sessionVotes,
  totalPairsRated,
  percentileRank,
  judgedPairs,
  remainingPairs,
}: JudgingSessionStatsProps) {
  const motionOn = !useReducedMotion(true);
  const totalPairs =
    judgedPairs !== undefined && remainingPairs !== undefined ? judgedPairs + remainingPairs : null;
  const percent = totalPairs ? Math.min(100, ((judgedPairs ?? 0) / totalPairs) * 100) : 0;

  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-baseline gap-4">
        <SessionStat value={numberWithCommas(sessionVotes)} label="this session" />
        <SessionStat value={numberWithCommas(totalPairsRated)} label="judged in total" />
        {!!percentileRank && (
          // The third stat is the first to go when the footer is squeezed between md and lg.
          <SessionStat
            className="md:max-lg:hidden"
            value={`Top ${percentileRank}%`}
            label="of judges"
          />
        )}
      </div>
      {totalPairs !== null && judgedPairs !== undefined && remainingPairs !== undefined && (
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
            <span className="truncate text-[#909296]">
              {numberWithCommas(judgedPairs)} of {numberWithCommas(totalPairs)} pairs judged here
            </span>
            <span className="shrink-0 font-semibold text-green-400">
              {numberWithCommas(remainingPairs)} to go
            </span>
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-[#373A40]"
            role="progressbar"
            aria-label="Pairs judged in this crucible"
            aria-valuemin={0}
            aria-valuemax={totalPairs}
            aria-valuenow={judgedPairs}
          >
            <LazyMotion features={loadMotion} strict>
              <MotionDiv
                className="h-full rounded-full bg-gradient-to-r from-blue-500 to-green-500"
                initial={false}
                animate={{ width: `${percent}%` }}
                transition={
                  motionOn ? { type: 'spring', stiffness: 220, damping: 24 } : { duration: 0 }
                }
              />
            </LazyMotion>
          </div>
        </div>
      )}
    </div>
  );
}

function SessionStat({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string;
}) {
  return (
    <div className={clsx('flex min-w-0 items-baseline gap-1', className)}>
      <span className="text-base font-bold text-white">{value}</span>
      <span className="truncate text-xs text-[#909296]">{label}</span>
    </div>
  );
}

function getTimeRemaining(endAt: Date): string {
  const now = new Date();
  const end = new Date(endAt);
  const diff = end.getTime() - now.getTime();

  if (diff <= 0) return 'Ended';

  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

  const hrs = `${hours} ${hours === 1 ? 'hr' : 'hrs'}`;
  if (days > 0) {
    return `${days} ${days === 1 ? 'day' : 'days'} ${hrs}`;
  }

  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) {
    return `${hrs} ${minutes} min`;
  }

  return `${minutes} min`;
}

export default Page(CrucibleJudgePage, {
  getLayout: (page) => (
    <AppLayout scrollable={false} footer={false}>
      {page}
    </AppLayout>
  ),
});
