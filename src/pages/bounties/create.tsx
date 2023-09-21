import { Anchor, Container, Text } from '@mantine/core';

import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';
import { BountyCreateForm } from '~/components/Bounty/BountyCreateForm';
import { DismissibleAlert } from '~/components/DismissibleAlert/DismissibleAlert';

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
            Want to keep creating cool stuff but don&apost have the power or expertise? You can post
            a bounty to let other people from the community help you out. Learn more about them by
            reading{' '}
            <Anchor href="" span>
              this article
            </Anchor>
            .
          </Text>
        }
      />
      <BountyCreateForm />
    </Container>
  );
}
