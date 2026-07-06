import { Center, Container, Text } from '@mantine/core';
import { NotFound } from '~/components/AppLayout/NotFound';
import { Meta } from '~/components/Meta/Meta';
import { UserChallengeUpsertForm } from '~/components/Challenge/UserChallengeUpsertForm';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export default function CreateUserChallengePage() {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();

  if (!features.challengePlatform || !features.userChallenges) {
    return <NotFound />;
  }

  if (!currentUser) {
    return (
      <Center py="xl">
        <Text>Please sign in to create a challenge.</Text>
      </Center>
    );
  }

  return (
    <>
      <Meta title="Create a Challenge" deIndex />
      <Container size="lg" py="md">
        <UserChallengeUpsertForm />
      </Container>
    </>
  );
}

export const getServerSideProps = createServerSideProps({ useSession: true });
