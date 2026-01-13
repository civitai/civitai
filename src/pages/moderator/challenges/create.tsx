import { Center, Container, Text } from '@mantine/core';
import { Meta } from '~/components/Meta/Meta';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { ChallengeUpsertForm } from '~/components/Challenge/ChallengeUpsertForm';

export default function CreateChallengePage() {
  const currentUser = useCurrentUser();

  if (!currentUser?.isModerator) {
    return (
      <Center py="xl">
        <Text>Access denied. You do not have permission to access this page.</Text>
      </Center>
    );
  }

  return (
    <>
      <Meta title="Create Challenge - Moderator" deIndex />
      <Container size="lg" py="md">
        <ChallengeUpsertForm />
      </Container>
    </>
  );
}
