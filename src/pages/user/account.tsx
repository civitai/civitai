import { Container, Stack, Title, Text, Button, Group, Divider } from '@mantine/core';
import { getProviders } from 'next-auth/react';
import React, { useMemo } from 'react';

import { AccountsCard } from '~/components/Account/AccountsCard';
import { ApiKeysCard } from '~/components/Account/ApiKeysCard';
import { SocialProfileCard } from '~/components/Account/SocialProfileCard';
import { DeleteCard } from '~/components/Account/DeleteCard';
import { NotificationsCard } from '~/components/Account/NotificationsCard';
import { ProfileCard } from '~/components/Account/ProfileCard';
import { SettingsCard } from '~/components/Account/SettingsCard';
import { SubscriptionCard } from '~/components/Account/SubscriptionCard';
import { Meta } from '~/components/Meta/Meta';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { ModerationCard } from '~/components/Account/ModerationCard';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { UserReferralCodesCard } from '~/components/Account/UserReferralCodesCard';
import { PaymentMethodsCard } from '~/components/Account/PaymentMethodsCard';
import { StripeConnectCard } from '../../components/Account/StripeConnectCard';
import { ContentControlsCard } from '~/components/Account/ContentControlsCard';

export default function Account({ providers }: Props) {
  const { apiKeys, buzz } = useFeatureFlags();
  const currentUser = useCurrentUser();

  return (
    <>
      <Meta title="Manage your Account - Civitai" />

      <Container pb="md" size="xs">
        <Stack>
          <Stack spacing={0}>
            <Title order={1}>Manage Account</Title>
            <Text color="dimmed" size="sm">
              Take a moment to review your account information and preferences to personalize your
              experience on the site
            </Text>
          </Stack>
          <ProfileCard />
          <SocialProfileCard />
          <SettingsCard />
          <ContentControlsCard />
          <ModerationCard />
          <AccountsCard providers={providers} />
          <StripeConnectCard />
          {currentUser?.subscriptionId && <SubscriptionCard />}
          <PaymentMethodsCard />
          {/* {buzz && <UserReferralCodesCard />} */}
          <NotificationsCard />
          {apiKeys && <ApiKeysCard />}
          <DeleteCard />
          <Divider label="Extras" />
          <Group spacing="sm">
            <Button variant="subtle" onClick={() => currentUser?.refresh()}>
              Refresh my session
            </Button>
          </Group>
        </Stack>
      </Container>
    </>
  );
}

type Props = {
  providers: AsyncReturnType<typeof getProviders>;
};

export const getServerSideProps = createServerSideProps({
  useSSG: true,
  useSession: true,
  resolver: async ({ ssg, session }) => {
    if (!session?.user || session.user.bannedAt)
      return {
        redirect: {
          destination: '/',
          permanent: false,
        },
      };

    const providers = await getProviders();
    await ssg?.account.getAll.prefetch();
    if (session?.user?.subscriptionId) await ssg?.stripe.getUserSubscription.prefetch();

    return {
      props: {
        providers,
      },
    };
  },
});
