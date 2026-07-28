import { Center, Container, Loader, Text } from '@mantine/core';
import { Meta } from '~/components/Meta/Meta';
import { ChallengeUpsertForm } from '~/components/Challenge/ChallengeUpsertForm';
import { ChallengeCreateRequirements } from '~/components/Challenge/ChallengeCreateRequirements';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

export default function CreateUserChallengePage() {
  const currentUser = useCurrentUser();

  const { data: eligibility, isLoading } = trpc.challenge.getCreateEligibility.useQuery(undefined, {
    enabled: !!currentUser,
  });

  if (!currentUser) {
    return (
      <Center py="xl">
        <Text>Please sign in to create a challenge.</Text>
      </Center>
    );
  }

  // On a query error `eligibility` stays undefined and no gate renders; the create mutation still
  // enforces it, degrading to the existing error-on-submit behavior.
  return (
    <>
      <Meta title="Create a Challenge" deIndex />
      <Container size="lg" py="md">
        {isLoading ? (
          <Center py="xl">
            <Loader />
          </Center>
        ) : (
          <>
            <ChallengeUpsertForm variant="user" />
            {eligibility && !eligibility.canCreate && (
              <ChallengeCreateRequirements eligibility={eligibility} />
            )}
          </>
        )}
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
