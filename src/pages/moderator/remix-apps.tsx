import { Container } from '@mantine/core';
import { Page } from '~/components/AppLayout/Page';
import { Meta } from '~/components/Meta/Meta';
import { RemixAppsAdmin } from '~/components/Moderation/RemixApps/RemixAppsAdmin';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  requireModerator: true,
  useSession: true,
  resolver: async ({ session, features }) => {
    if (!session?.user?.isModerator) return { redirect: { destination: '/', permanent: false } };
    if (!features?.remixApps) return { notFound: true };
    return { props: {} };
  },
});

function RemixAppsPage() {
  return (
    <>
      <Meta title="Remix Apps" deIndex />
      <Container size="lg" py="lg">
        <RemixAppsAdmin />
      </Container>
    </>
  );
}

export default Page(RemixAppsPage);
