import {
  ActionIcon,
  Alert,
  Container,
  Group,
  Popover,
  Text,
  Title,
  Button,
  Box,
} from '@mantine/core';
import type { InferGetServerSidePropsType } from 'next';
import Link from 'next/link';
import * as z from 'zod';
import {
  IconArrowLeft,
  IconClock,
  IconUsers,
  IconRefresh,
  IconAlertCircle,
  IconInfoCircle,
} from '@tabler/icons-react';
import { useState, useCallback, useEffect, useRef } from 'react';
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
import { CrucibleJudgingDoneState } from '~/components/Crucible/CrucibleJudgingDoneState';
import { CrucibleJudgingUI } from '~/components/Crucible/CrucibleJudgingUI';
import { useJudgeSkipList } from '~/components/Crucible/judge-skip-list';
import type { JudgingPairData, WatchedMs } from '~/components/Crucible/CrucibleJudgingUI';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import { getCrucibleUrl, isCrucibleSfw } from '~/utils/crucible-helpers';
import { numberWithCommas } from '~/utils/number-helpers';
import { showErrorNotification } from '~/utils/notifications';
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
  const [sessionSkips, setSessionSkips] = useState(0);
  const [currentStreak, setCurrentStreak] = useState(0); // Consecutive votes without skip
  const [isVoting, setIsVoting] = useState(false);
  const [allPairsJudged, setAllPairsJudged] = useState(false);
  const [closedByServer, setClosedByServer] = useState(false);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [lastVoteAttempt, setLastVoteAttempt] = useState<{
    winnerId: number;
    loserId: number;
    watched: WatchedMs;
  } | null>(null);

  const { skippedEntryIds, skip, recordVote } = useJudgeSkipList();
  // One judging session per visit to this page: leaving and coming back means watching in full again.
  const [judgingSessionId] = useState(uuidv4);

  // Held in state rather than derived during render: `new Date()` differs between the server and
  // the client, so deriving it inline is a hydration mismatch.
  const [timeRemaining, setTimeRemaining] = useState<string | null>(null);
  const [hasEnded, setHasEnded] = useState(false);

  // Fetch crucible details
  const { data: crucible, isLoading: isLoadingCrucible } = trpc.crucible.getById.useQuery({ id });

  const entryCount = crucible?._count?.entries ?? 0;
  // A judge is never shown their own entries.
  const judgeableEntryCount = entryCount - (crucible?.viewerEntries.length ?? 0);
  const canRequestPairs =
    !!currentUser &&
    crucible?.status === CrucibleStatus.Active &&
    judgeableEntryCount >= 2 &&
    !hasEnded &&
    !closedByServer;

  // Fetch judging pair (exclude recently skipped entries)
  const {
    data: pairData,
    isLoading: isLoadingPair,
    isFetching: isFetchingPair,
    error: pairError,
    refetch: refetchPair,
  } = trpc.crucible.getJudgingPair.useQuery(
    {
      crucibleId: id,
      browsingLevel,
      excludeEntryIds: skippedEntryIds.length > 0 ? skippedEntryIds : undefined,
      judgingSessionId,
    },
    {
      enabled: canRequestPairs,
      refetchOnWindowFocus: false,
      // A skip list can recur once a vote takes an entry off it. Its cached pair is stale
      // (staleTime is Infinity app-wide), so nothing is kept once the input moves on.
      gcTime: 0,
    }
  );

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
      if (isVoting || isLoadingPair || !pair) return;

      if (!unavailable) {
        setSessionSkips((prev) => prev + 1);
        setCurrentStreak(0);
      }
      skip(pair);
    },
    [isVoting, isLoadingPair, pair, skip]
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
  const influenceScore = judgeStats?.influenceScore ?? 0;

  return (
    <>
      <Meta
        title={`Judging: ${crucible.name} | Civitai Crucible`}
        description={`Help judge ${crucible.name} - vote on image pairs to determine the winner.`}
        canonical={`${env.NEXT_PUBLIC_BASE_URL}/crucibles/${crucible.id}/judge`}
      />

      <div className="-mt-3 flex h-[calc(100%+0.75rem)] flex-col overflow-y-auto md:overflow-hidden">
        <Box className="shrink-0 border-b border-[#373a40] bg-[#25262b]" py="sm">
          <Container size="xl">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
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
                <div className="min-w-0">
                  <h1 className="truncate text-xl font-bold leading-tight text-white">
                    Judging: {crucible.name}
                  </h1>
                  <Text size="xs" c="dimmed">
                    Compare pairs and vote for your favorite
                  </Text>
                </div>
              </div>

              {timeRemaining && (
                <div
                  className="inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold"
                  style={{
                    background: 'rgba(250, 82, 82, 0.1)',
                    border: '1px solid rgba(250, 82, 82, 0.3)',
                    color: '#ff8787',
                  }}
                >
                  <IconClock size={14} />
                  <span>{timeRemaining} remaining</span>
                </div>
              )}
            </div>

            {!showDoneState && (
              <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-5">
                <StatItem
                  label="Pairs Left"
                  value={progress ? numberWithCommas(progress.remainingPairs) : '-'}
                  secondary="For you to judge here"
                />
                <StatItem
                  label="Pairs Rated This Session"
                  value={numberWithCommas(sessionVotes)}
                  secondary={
                    sessionSkips > 0 ? `${numberWithCommas(sessionSkips)} skipped` : undefined
                  }
                />
                <StatItem
                  label="Total Pairs Rated"
                  value={numberWithCommas((judgeStats?.totalPairsRated ?? 0) + sessionVotes)}
                  secondary={
                    judgeStats?.percentileRank
                      ? `Top ${judgeStats.percentileRank}% of judges`
                      : 'Keep judging!'
                  }
                />
                <StatItem
                  label="Current Streak"
                  value={currentStreak > 0 ? `${numberWithCommas(currentStreak)} pairs` : '0'}
                  secondary={
                    currentStreak > 0 ? 'Votes in a row, no skips' : 'Vote to build streak'
                  }
                />
                <StatItem
                  label="Your Influence"
                  value={numberWithCommas(influenceScore)}
                  secondary="Doesn't weight your votes"
                  info={
                    <>
                      Influence measures how much judging you&apos;ve done across all crucibles: 10
                      × the square root of your total pairs rated (100 pairs → 100, 400 pairs →
                      200). It doesn&apos;t change how much your votes count: every judge&apos;s
                      vote carries the same weight in the rankings.
                    </>
                  }
                />
              </div>
            )}
          </Container>
        </Box>

        <Container size="xl" className="flex w-full flex-1 flex-col py-4 md:min-h-0">
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
                sessionVotes={sessionVotes}
                onlyOwnEntries={onlyOwnEntries}
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
            <CrucibleJudgingUI
              className="flex-1 md:min-h-0"
              pair={pair}
              isLoading={isLoadingPair || isVoting}
              disabled={isVoting || !!voteError}
              minViewSeconds={crucible.minViewSeconds}
              onVote={handleVote}
              onSkip={handleSkip}
            />
          )}
        </Container>
      </div>
    </>
  );
}

// Helper Components

type StatItemProps = {
  label: string;
  value: string;
  secondary?: string;
  info?: React.ReactNode;
};

function StatItem({ label, value, secondary, info }: StatItemProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <div
        className="flex items-center gap-1 text-xs font-semibold uppercase"
        style={{ color: '#909296', letterSpacing: '0.05em' }}
      >
        {label}
        {info && (
          <Popover width={280} position="bottom" withArrow withinPortal shadow="md">
            <Popover.Target>
              <ActionIcon
                variant="subtle"
                color="gray"
                size="xs"
                aria-label={`What is ${label.toLowerCase()}?`}
              >
                <IconInfoCircle size={14} />
              </ActionIcon>
            </Popover.Target>
            <Popover.Dropdown>
              <Text size="xs">{info}</Text>
            </Popover.Dropdown>
          </Popover>
        )}
      </div>
      <div className="text-lg font-bold leading-tight text-white">{value}</div>
      {secondary && (
        <div className="text-xs" style={{ color: '#a6e3a1' }}>
          {secondary}
        </div>
      )}
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

  if (days > 0) {
    return `${days} days ${hours} hrs`;
  }

  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) {
    return `${hours} hrs ${minutes} min`;
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
