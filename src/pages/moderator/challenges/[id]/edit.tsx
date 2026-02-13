import { Center, Container, Loader, Text } from '@mantine/core';
import { useRouter } from 'next/router';
import { Meta } from '~/components/Meta/Meta';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ChallengeUpsertForm } from '~/components/Challenge/ChallengeUpsertForm';
import { trpc } from '~/utils/trpc';
import { NotFound } from '~/components/AppLayout/NotFound';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

export default function EditChallengePage() {
  const router = useRouter();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const challengeId = Number(router.query.id);

  const { data: challenge, isLoading } = trpc.challenge.getById.useQuery(
    { id: challengeId },
    { enabled: !!challengeId && !isNaN(challengeId) }
  );

  if (!features.challengePlatform) {
    return <NotFound />;
  }

  if (!currentUser?.isModerator) {
    return (
      <Center py="xl">
        <Text>Access denied. You do not have permission to access this page.</Text>
      </Center>
    );
  }

  if (isLoading) {
    return (
      <Center py="xl">
        <Loader size="xl" />
      </Center>
    );
  }

  if (!challenge) {
    return <NotFound />;
  }

  // Transform the challenge data to match the form's expected format
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
  };

  return (
    <>
      <Meta title={`Edit Challenge: ${challenge.title} - Moderator`} deIndex />
      <Container size="lg" py="md">
        <ChallengeUpsertForm challenge={challengeForForm} />
      </Container>
    </>
  );
}
