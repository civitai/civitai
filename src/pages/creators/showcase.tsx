import { Container } from '@mantine/core';
import { CreatorShowcase } from '~/components/CreatorJourney/CreatorShowcase';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features }) => {
    if (!features?.creatorJourney) return { notFound: true };
  },
});

export default function CreatorShowcasePage() {
  return (
    <>
      <Meta title="Creator Showcase | Civitai" deIndex />
      <Container size="lg" py="xl">
        <CreatorShowcase />
      </Container>
    </>
  );
}
