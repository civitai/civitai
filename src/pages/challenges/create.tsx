import { Center, Container, Text } from '@mantine/core';
import { Meta } from '~/components/Meta/Meta';
import { ChallengeUpsertForm } from '~/components/Challenge/ChallengeUpsertForm';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export default function CreateUserChallengePage() {
  const currentUser = useCurrentUser();

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
        <ChallengeUpsertForm variant="user" />
      </Container>
    </>
  );
}

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.challengePlatform || !features?.userChallenges) return { notFound: true };
  },
});
