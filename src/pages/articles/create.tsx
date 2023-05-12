import { Container } from '@mantine/core';

import { ArticleUpsertForm } from '~/components/Article/ArticleUpsertForm';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx }) => {
    const features = getFeatureFlags({ user: session?.user });
    if (!features.articleCreate) return { notFound: true };

    if (!session)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl, reason: 'create-article' }),
          permanent: false,
        },
      };
    if (session.user?.muted) return { notFound: true };
  },
});

export default function ArticleCreate() {
  return (
    <Container size="lg" py="xl">
      <ArticleUpsertForm />
    </Container>
  );
}
