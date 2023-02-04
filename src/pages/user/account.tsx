import { Container, Stack, Title, Text } from '@mantine/core';
import { getProviders } from 'next-auth/react';
import React from 'react';

import { AccountsCard } from '~/components/Account/AccountsCard';
import { ApiKeysCard } from '~/components/Account/ApiKeysCard';
import { CreatorCard } from '~/components/Account/CreatorCard';
import { DeleteCard } from '~/components/Account/DeleteCard';
import { NotificationsCard } from '~/components/Account/NotificationsCard';
import { ProfileCard } from '~/components/Account/ProfileCard';
import { SettingsCard } from '~/components/Account/SettingsCard';
import { SubscriptionCard } from '~/components/Account/SubscriptionCard';
import { TagsCard } from '~/components/Account/TagsCard';
import { Meta } from '~/components/Meta/Meta';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export default function Account({ providers }: Props) {
  const { apiKeys } = useFeatureFlags();
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
          <CreatorCard />
          <SettingsCard />
          <TagsCard />
          <NotificationsCard />
          <AccountsCard providers={providers} />
          {currentUser?.subscriptionId && <SubscriptionCard />}
          {apiKeys && <ApiKeysCard />}
          <DeleteCard />
        </Stack>
      </Container>
    </>
  );
}

type Props = {
  providers: AsyncReturnType<typeof getProviders>;
};

// export const getServerSideProps: GetServerSideProps<Props> = async (context) => {
//   const session = await getServerAuthSession(context);

//   if (!session?.user)
//     return {
//       redirect: {
//         destination: '/',
//         permanent: false,
//       },
//     };

//   const providers = await getProviders();
//   const ssg = await getServerProxySSGHelpers(context);
//   await ssg.account.getAll.prefetch();

//   return {
//     props: {
//       trpcState: ssg.dehydrate(),
//       providers,
//       isDev: env.NODE_ENV === 'development', // TODO: Remove this once API Keys feature is complete
//     },
//   };
// };

export const getServerSideProps = createServerSideProps({
  useSSG: true,
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
