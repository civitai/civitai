import { Container } from '@mantine/core';
import { CreatorJourney } from '~/components/CreatorJourney/CreatorJourney';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx, features }) => {
    if (!features?.creatorJourney) return { notFound: true };
    if (!session?.user)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };
  },
});

export default function CreatorJourneyPage() {
  return (
    <>
      <Meta title="Your Creator Journey | Civitai" deIndex />
      <Container size="md" pt={0} pb="xl">
        <CreatorJourney />
      </Container>
    </>
  );
}
