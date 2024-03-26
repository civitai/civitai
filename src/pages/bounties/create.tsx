import { Container, Text } from '@mantine/core';

import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';
import { BountyUpsertForm } from '~/components/Bounty/BountyUpsertForm';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx }) => {
    const features = getFeatureFlags({ user: session?.user });
    if (!features.bounties) return { notFound: true };

    if (!session)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl, reason: 'create-bounty' }),
          permanent: false,
        },
      };
    if (session.user?.muted) return { notFound: true };
  },
});

export default function BountyCreate() {
  return (
    <Container size="md">
      <DismissibleAlert
        id="faq-create-bounty"
        title="What are bounties?"
        emoji="❕"
        mb="xl"
        size="md"
        color="blue"
        content={
          <Text>
            Use bounties to make requests of the community. For example you could request a custom
            model, a curated data set, or even just some cool pictures in styles you&apos;re not
            able to replicate, then offer compensation to the people who helped you.
          </Text>
        }
      />
      <BountyUpsertForm />
    </Container>
  );
}
