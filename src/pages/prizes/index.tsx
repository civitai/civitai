import { Container, Stack, Text, Title } from '@mantine/core';
import { Meta } from '~/components/Meta/Meta';
import { PageLoader } from '~/components/PageLoader/PageLoader';
import { PrizeClaimCard } from '~/components/Prize/PrizeClaimCard';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { trpc } from '~/utils/trpc';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx }) => {
    if (!session)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl, reason: 'perform-action' }),
          permanent: false,
        },
      };
    return { props: {} };
  },
});

export default function PrizesPage() {
  const { data: prizes, isLoading } = trpc.prize.getMine.useQuery();

  if (isLoading) return <PageLoader />;

  return (
    <>
      <Meta title="Your prizes | Civitai" deIndex />
      <Container size="xs" my="xl">
        <Stack gap="md">
          <Title order={1}>Your prizes</Title>
          {prizes?.length ? (
            prizes.map((prize) => <PrizeClaimCard key={prize.id} prize={prize} />)
          ) : (
            <Text c="dimmed">You have no prizes yet.</Text>
          )}
        </Stack>
      </Container>
    </>
  );
}
