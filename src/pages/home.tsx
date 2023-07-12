import { Container, Title } from '@mantine/core';
import { HomeContentToggle } from '~/components/HomeContentToggle/HomeContentToggle';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session }) => {
    const features = getFeatureFlags({ user: session?.user });
    if (!features.alternateHome) return { notFound: true };

    return { props: {} };
  },
});

export default function Home() {
  return (
    <Container size="xl">
      <Title order={1}>Home</Title>
      <HomeContentToggle />
    </Container>
  );
}
