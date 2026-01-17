import {
  Alert,
  Container,
  Group,
  Paper,
  Text,
  Title,
  Button,
  Box,
  Anchor,
  Loader,
} from '@mantine/core';
import type { InferGetServerSidePropsType } from 'next';
import { useRouter } from 'next/router';
import Link from 'next/link';
import * as z from 'zod';
import {
  IconArrowLeft,
  IconClock,
  IconTrophy,
  IconCoin,
  IconUsers,
  IconLayoutGrid,
  IconRefresh,
  IconAlertCircle,
} from '@tabler/icons-react';
import { useState, useCallback, useEffect } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';
import { env } from '~/env/client';
import { slugit } from '~/utils/string-helpers';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  CrucibleJudgingUI,
  CrucibleJudgingUISkeleton,
} from '~/components/Crucible/CrucibleJudgingUI';
import type { JudgingPairData } from '~/components/Crucible/CrucibleJudgingUI';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';
import { abbreviateNumber } from '~/utils/number-helpers';
import { showErrorNotification } from '~/utils/notifications';
import { LoginRedirect } from '~/components/LoginRedirect/LoginRedirect';

const querySchema = z.object({
  id: z.coerce.number(),
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

function CrucibleJudgePage({ id }: InferGetServerSidePropsType<typeof getServerSideProps>) {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const utils = trpc.useUtils();

  // Session stats
  const [sessionVotes, setSessionVotes] = useState(0);
  const [sessionSkips, setSessionSkips] = useState(0);
  const [currentStreak, setCurrentStreak] = useState(0); // Consecutive votes without skip
  const [isVoting, setIsVoting] = useState(false);
  const [allPairsJudged, setAllPairsJudged] = useState(false);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [lastVoteAttempt, setLastVoteAttempt] = useState<{
    winnerId: number;
    loserId: number;
  } | null>(null);

  // Track skipped entry IDs to prevent immediate return
  // Keep last 20 entries (~10 pairs) so skipped pairs can return after showing others
  const [skippedEntryIds, setSkippedEntryIds] = useState<number[]>([]);

  // Fetch crucible details
  const { data: crucible, isLoading: isLoadingCrucible } = trpc.crucible.getById.useQuery({ id });

  // Fetch judging pair (exclude recently skipped entries)
  const {
    data: pairData,
    isLoading: isLoadingPair,
    refetch: refetchPair,
  } = trpc.crucible.getJudgingPair.useQuery(
    { crucibleId: id, excludeEntryIds: skippedEntryIds.length > 0 ? skippedEntryIds : undefined },
    {
      enabled: !!currentUser && !!crucible,
      refetchOnWindowFocus: false,
    }
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

      if (isNetworkError) {
        setVoteError('Network error. Please check your connection and try again.');
      } else if (
        error.message.includes('already voted') ||
        error.message.includes('already being processed')
      ) {
        // Race condition - silently fetch next pair
        setVoteError(null);
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
          score: pairData.left.score,
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
          score: pairData.right.score,
          image: pairData.right.image,
          user: {
            id: pairData.right.user.id,
            username: pairData.right.user.username,
            deletedAt: pairData.right.user.deletedAt,
            image: pairData.right.user.image,
          },
        },
      }
    : null;

  // Handle vote
  const handleVote = useCallback(
    async (winnerId: number, loserId: number) => {
      if (isVoting || !pair) return;

      setIsVoting(true);
      setVoteError(null);
      setLastVoteAttempt({ winnerId, loserId });

      try {
        await submitVoteMutation.mutateAsync({
          crucibleId: id,
          winnerEntryId: winnerId,
          loserEntryId: loserId,
        });

        setSessionVotes((prev) => prev + 1);
        setCurrentStreak((prev) => prev + 1); // Increment streak on vote
        setLastVoteAttempt(null);
        // Refetch immediately - UI feedback delay is handled in CrucibleJudgingUI (200ms)
        const result = await refetchPair();
        if (!result.data) {
          setAllPairsJudged(true);
        }
        setIsVoting(false);
      } catch {
        setIsVoting(false);
      }
    },
    [isVoting, pair, id, submitVoteMutation, refetchPair]
  );

  // Retry last vote attempt
  const handleRetryVote = useCallback(() => {
    if (lastVoteAttempt && !isVoting) {
      handleVote(lastVoteAttempt.winnerId, lastVoteAttempt.loserId);
    }
  }, [lastVoteAttempt, isVoting, handleVote]);

  // Handle skip - track skipped entries, then get next pair (pair may return after ~10 others)
  const handleSkip = useCallback(async () => {
    if (isVoting || !pair) return;

    setIsVoting(true);
    setSessionSkips((prev) => prev + 1);
    setCurrentStreak(0); // Reset streak on skip

    // Track skipped entry IDs to exclude from next pair selection
    // Keep only the last 20 entries (~10 pairs) so skipped pairs can eventually return
    const newSkippedIds = [...skippedEntryIds, pair.left.id, pair.right.id].slice(-20);
    setSkippedEntryIds(newSkippedIds);

    // For skip, get the next pair immediately without recording a vote
    // No artificial delay - skip should feel instant
    const result = await refetchPair();
    if (!result.data) {
      setAllPairsJudged(true);
    }
    setIsVoting(false);
  }, [isVoting, pair, refetchPair, skippedEntryIds]);

  // Check if all pairs judged on initial load
  useEffect(() => {
    if (currentUser && !isLoadingPair && pairData === null) {
      setAllPairsJudged(true);
    }
  }, [currentUser, isLoadingPair, pairData]);

  // Loading state
  if (isLoadingCrucible) return <PageLoader />;
  if (!crucible) return <NotFound />;

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

  // Check if crucible is active
  const isActive = crucible.status === CrucibleStatus.Active;
  if (!isActive) {
    return (
      <Container size="lg" className="py-16 text-center">
        <Title order={2} mb="md">
          Judging Not Available
        </Title>
        <Text c="dimmed" mb="xl">
          This crucible is not currently accepting votes.
        </Text>
        <Button component={Link} href={`/crucibles/${id}/${slugit(crucible.name)}`}>
          Back to Crucible
        </Button>
      </Container>
    );
  }

  const entryCount = crucible._count?.entries ?? 0;

  // Check if there are enough entries to judge (need at least 2)
  if (entryCount < 2) {
    return (
      <Container size="lg" className="py-16 text-center">
        <IconUsers className="mx-auto mb-4 h-16 w-16 text-gray-500" />
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
          <Button component={Link} href={`/crucibles/${id}/${slugit(crucible.name)}`}>
            Back to Crucible
          </Button>
        </Group>
      </Container>
    );
  }
  const totalPrizePool = crucible.entryFee * entryCount;

  // Use client-side state for time remaining to avoid hydration mismatch
  // (new Date() returns different values on server vs client)
  const [timeRemaining, setTimeRemaining] = useState<string | null>(null);

  useEffect(() => {
    const endAt = crucible.endAt;
    if (!endAt) return;

    // Calculate immediately on client hydration
    setTimeRemaining(getTimeRemaining(endAt));

    // Update every minute
    const interval = setInterval(() => {
      setTimeRemaining(getTimeRemaining(endAt));
    }, 60000);

    return () => clearInterval(interval);
  }, [crucible.endAt]);

  return (
    <>
      <Meta
        title={`Judging: ${crucible.name} | Civitai Crucible`}
        description={`Help judge ${crucible.name} - vote on image pairs to determine the winner.`}
        links={[
          {
            href: `${env.NEXT_PUBLIC_BASE_URL}/crucibles/${crucible.id}/judge`,
            rel: 'canonical',
          },
        ]}
      />

      {/* Header Section */}
      <Box className="border-b border-[#373a40] bg-[#25262b] py-4">
        <Container size="xl">
          {/* Back Link */}
          <Link
            href={`/crucibles/${id}/${slugit(crucible.name)}`}
            className="mb-4 flex items-center gap-2 text-blue-500 transition-colors hover:text-blue-400"
          >
            <IconArrowLeft size={16} />
            Back to Crucible
          </Link>

          {/* Title Row */}
          <div className="mt-4 flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
            <div>
              <Title order={2} className="text-white">
                Judging: {crucible.name}
              </Title>
              <Text size="sm" c="dimmed" mt={4}>
                Compare pairs and vote for your favorite
              </Text>
            </div>

            {/* Time Remaining Badge */}
            {timeRemaining && (
              <Paper
                className="flex items-center gap-2 border border-red-500/30 bg-red-500/10 px-4 py-2"
                radius="md"
              >
                <IconClock size={16} className="text-red-400" />
                <Text size="sm" fw={600} className="text-red-400">
                  {timeRemaining} remaining
                </Text>
              </Paper>
            )}
          </div>
        </Container>
      </Box>

      {/* Stats Bar */}
      {!allPairsJudged && (
        <Box className="border-b border-[#373a40] bg-[#25262b] py-6">
          <Container size="xl">
            <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
              <StatItem
                label="Pairs Rated This Session"
                value={sessionVotes.toString()}
                secondary={sessionSkips > 0 ? `${sessionSkips} skipped` : undefined}
              />
              <StatItem
                label="Total Pairs Rated"
                value={abbreviateNumber((judgeStats?.totalPairsRated ?? 0) + sessionVotes)}
                secondary={
                  judgeStats?.percentileRank
                    ? `Top ${judgeStats.percentileRank}% of judges`
                    : 'Keep judging!'
                }
              />
              <StatItem
                label="Current Streak"
                value={currentStreak > 0 ? `${currentStreak} pairs` : '0'}
                secondary={currentStreak >= 5 ? '+2 influence score' : 'Vote to build streak'}
              />
              <StatItem
                label="Your Influence"
                value={(judgeStats?.influenceScore ?? 100).toString()}
                secondary={
                  (judgeStats?.influenceScore ?? 100) >= 150
                    ? "You're influential!"
                    : 'Growing influence'
                }
              />
            </div>
          </Container>
        </Box>
      )}

      {/* Main Voting Area or End State */}
      <Container size="xl" className="py-8">
        {/* Network Error Banner with Retry */}
        {voteError && (
          <Alert
            icon={<IconAlertCircle size={18} />}
            title="Connection Error"
            color="red"
            mb="lg"
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

        {allPairsJudged ? (
          <EndCrucibleState
            crucibleId={id}
            crucibleName={crucible.name}
            sessionVotes={sessionVotes}
          />
        ) : (
          <CrucibleJudgingUI
            pair={pair}
            isLoading={isLoadingPair || isVoting}
            disabled={isVoting || !!voteError}
            onVote={handleVote}
            onSkip={handleSkip}
          />
        )}
      </Container>
    </>
  );
}

// Helper Components

type StatItemProps = {
  label: string;
  value: string;
  secondary?: string;
};

function StatItem({ label, value, secondary }: StatItemProps) {
  return (
    <div className="flex flex-col gap-1">
      <Text size="xs" c="dimmed" fw={600} tt="uppercase" className="tracking-wider">
        {label}
      </Text>
      <Text className="text-2xl font-bold text-white">{value}</Text>
      {secondary && (
        <Text size="xs" className="text-green-400">
          {secondary}
        </Text>
      )}
    </div>
  );
}

type EndCrucibleStateProps = {
  crucibleId: number;
  crucibleName: string;
  sessionVotes: number;
};

function EndCrucibleState({ crucibleId, crucibleName, sessionVotes }: EndCrucibleStateProps) {
  const router = useRouter();

  // Fetch other active crucibles to suggest
  const { data: otherCrucibles, isLoading } = trpc.crucible.getInfinite.useQuery(
    { status: CrucibleStatus.Active, limit: 4 },
    { refetchOnWindowFocus: false }
  );

  // Filter out current crucible
  const suggestedCrucibles = otherCrucibles?.items.filter((c) => c.id !== crucibleId) ?? [];

  return (
    <div className="mx-auto max-w-4xl py-8 text-center">
      <div className="mb-2 text-4xl">
        <IconTrophy className="mx-auto h-16 w-16 text-green-400" />
      </div>
      <Title order={2} className="mb-2 text-white">
        You've rated all available pairs!
      </Title>
      <Text c="dimmed" mb="xl">
        {sessionVotes > 0
          ? `Great judging session! You rated ${sessionVotes} pairs.`
          : 'Check back soon for new pairs to judge.'}
      </Text>

      <Button
        variant="light"
        size="lg"
        component={Link}
        href={`/crucibles/${crucibleId}/${slugit(crucibleName)}`}
        mb="xl"
      >
        Back to {crucibleName}
      </Button>

      {/* Suggested Crucibles */}
      {suggestedCrucibles.length > 0 && (
        <>
          <Title order={4} className="mb-6 mt-8 text-left text-white">
            Continue Judging These Crucibles
          </Title>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {suggestedCrucibles.slice(0, 4).map((c) => (
              <SuggestedCrucibleCard
                key={c.id}
                id={c.id}
                name={c.name}
                entryFee={c.entryFee}
                entryCount={c._count?.entries ?? 0}
              />
            ))}
          </div>
        </>
      )}

      {isLoading && (
        <div className="flex justify-center py-8">
          <Loader size="md" />
        </div>
      )}
    </div>
  );
}

type SuggestedCrucibleCardProps = {
  id: number;
  name: string;
  entryFee: number;
  entryCount: number;
};

function SuggestedCrucibleCard({ id, name, entryFee, entryCount }: SuggestedCrucibleCardProps) {
  const totalPrizePool = entryFee * entryCount;
  const pairsToJudge = Math.max(0, Math.floor((entryCount * (entryCount - 1)) / 2));

  return (
    <Paper
      className="rounded-xl border border-[#373a40] p-6 text-left transition-all hover:border-blue-500 hover:-translate-y-0.5"
      bg="dark.7"
    >
      <Text className="mb-4 text-lg font-bold text-white" lineClamp={1}>
        {name}
      </Text>

      <div className="mb-4 flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm text-gray-300">
          <IconCoin size={16} className="text-blue-500" />
          <span>Prize Pool: {abbreviateNumber(totalPrizePool)} Buzz</span>
        </div>
        <div className="flex items-center gap-2 text-sm text-gray-300">
          <IconLayoutGrid size={16} className="text-blue-500" />
          <span>{abbreviateNumber(pairsToJudge)} pairs to judge</span>
        </div>
        <div className="flex items-center gap-2 text-sm text-gray-300">
          <IconUsers size={16} className="text-blue-500" />
          <span>{entryCount} entries</span>
        </div>
      </div>

      <Button
        component={Link}
        href={`/crucibles/${id}/judge`}
        fullWidth
        className="bg-blue-600 hover:bg-blue-500"
      >
        Start Judging
      </Button>
    </Paper>
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

export default Page(CrucibleJudgePage);
