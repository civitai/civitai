import { Center, Container, Loader } from '@mantine/core';
import { useRouter } from 'next/router';
import { Meta } from '~/components/Meta/Meta';
import { ChallengeUpsertForm } from '~/components/Challenge/ChallengeUpsertForm';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { ChallengeSource } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';

export default function EditUserChallengePage() {
  const router = useRouter();
  const features = useFeatureFlags();
  const challengeId = Number(router.query.id);

  const { data: challenge, isLoading } = trpc.challenge.getUserChallengeForEdit.useQuery(
    { id: challengeId },
    { enabled: !!challengeId && !isNaN(challengeId), retry: false }
  );

  if (!features.challengePlatform || !features.userChallenges) return <NotFound />;

  if (isLoading) {
    return (
      <Center py="xl">
        <Loader size="xl" />
      </Center>
    );
  }

  if (!challenge) return <NotFound />;

  const challengeForForm = {
    id: challenge.id,
    title: challenge.title,
    description: challenge.description,
    theme: challenge.theme,
    invitation: challenge.invitation,
    coverImage: challenge.coverImage
      ? { id: challenge.coverImage.id, url: challenge.coverImage.url }
      : null,
    modelVersionIds: challenge.modelVersionIds ?? [],
    nsfwLevel: challenge.nsfwLevel,
    allowedNsfwLevel: challenge.allowedNsfwLevel ?? 1,
    judgeId: challenge.judge?.id ?? null,
    eventId: challenge.eventId ?? null,
    judgingPrompt: challenge.judgingPrompt,
    reviewPercentage: challenge.reviewPercentage,
    maxEntriesPerUser: challenge.maxEntriesPerUser,
    entryPrizeRequirement: challenge.entryPrizeRequirement ?? 10,
    prizePool: challenge.prizePool,
    operationBudget: challenge.operationBudget ?? 0,
    reviewCostType: challenge.reviewCostType ?? 'None',
    reviewCost: challenge.reviewCost ?? 0,
    startsAt: new Date(challenge.startsAt),
    endsAt: new Date(challenge.endsAt),
    visibleAt: new Date(challenge.visibleAt),
    status: challenge.status,
    source: challenge.source,
    prizes: challenge.prizes,
    entryPrize: challenge.entryPrize,
    prizeMode: challenge.prizeMode,
    basePrizePool: challenge.basePrizePool,
    buzzPerAction: challenge.buzzPerAction,
    poolTrigger: challenge.poolTrigger,
    maxPrizePool: challenge.maxPrizePool,
    prizeDistribution: challenge.prizeDistribution,
    themeElements: challenge.themeElements,
    judgingCategories: challenge.judgingCategories ?? undefined,
    entryFee: challenge.entryFee,
    maxParticipants: challenge.maxParticipants,
    initialPrizeBuzz:
      challenge.source === ChallengeSource.User ? challenge.basePrizePool : undefined,
  };

  return (
    <>
      <Meta title={`Edit Challenge: ${challenge.title}`} deIndex />
      <Container size="lg" py="md">
        <ChallengeUpsertForm variant="user" challenge={challengeForForm} />
      </Container>
    </>
  );
}

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, features, ctx }) => {
    if (!features?.challengePlatform || !features?.userChallenges) return { notFound: true };
    if (!session)
      return {
        redirect: {
          destination: `/login?returnUrl=${encodeURIComponent(ctx.resolvedUrl)}`,
          permanent: false,
        },
      };
  },
});
