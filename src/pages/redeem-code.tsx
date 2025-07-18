import { Container, Stack, Text, Title } from '@mantine/core';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/router';
import React, { useEffect } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { RedeemCodeCard } from '~/components/RedeemCode/RedeemCodeCard';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { env } from '~/env/client';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { getLoginLink } from '~/utils/login-helpers';

const RedeemCodeModal = dynamic(() =>
  import('~/components/RedeemableCode/RedeemCodeModal').then((x) => x.RedeemCodeModal)
);

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ features, session, ctx }) => {
    if (!features?.buzz) {
      return { notFound: true };
    }

    if (!session)
      return {
        redirect: {
          destination: getLoginLink({ returnUrl: ctx.resolvedUrl }),
          permanent: false,
        },
      };
  },
});

export default function RedeemCodePage() {
  const { query } = useRouter();

  // Handle direct redemption from URL parameters
  useEffect(() => {
    if (!query?.code || typeof window === 'undefined') return;
    dialogStore.trigger({
      id: 'redeem-code',
      component: RedeemCodeModal,
      props: { code: query.code as string },
    });
  }, [query.code]);

  return (
    <>
      <Meta
        title="Civitai | Redeem Buzz Code"
        description="Redeem your Buzz codes for rewards and exclusive perks on Civitai."
        links={
          env.NEXT_PUBLIC_BASE_URL
            ? [{ href: `${env.NEXT_PUBLIC_BASE_URL}/redeem-code`, rel: 'canonical' }]
            : undefined
        }
      />
      <Container size="md">
        <Stack gap="xl" py="xl">
          <div className="text-center">
            <Title order={1} size="h1" className="mb-4">
              Redeem Buzz Code
            </Title>
            <Text size="lg" c="dimmed" className="mx-auto max-w-2xl">
              Enter your Buzz code below to get your Buzz or membership on Civitai. Codes can be
              purchased through our marketplace or obtained via promotions and events.
            </Text>
          </div>

          <RedeemCodeCard
            size="lg"
            description="Enter your unique Buzz code to unlock instant rewards and exclusive benefits."
            showHeader={false}
          />

          {/* Additional Information Section */}
          <div className="mt-8 rounded-xl bg-gray-50 p-6 dark:bg-gray-800">
            <Title order={3} size="h3" className="mb-4 text-center">
              How Buzz Codes Work
            </Title>
            <div className="grid gap-6 md:grid-cols-3">
              <div className="text-center">
                <div className="mb-2 text-4xl">🎫</div>
                <Title order={4} size="h5" className="mb-2">
                  Get Your Code
                </Title>
                <Text size="sm" c="dimmed">
                  Obtain codes through events, partnerships, or community activities
                </Text>
              </div>
              <div className="text-center">
                <div className="mb-2 text-4xl">✨</div>
                <Title order={4} size="h5" className="mb-2">
                  Redeem Instantly
                </Title>
                <Text size="sm" c="dimmed">
                  Enter your code above and receive your rewards immediately
                </Text>
              </div>
              <div className="text-center">
                <div className="mb-2 text-4xl">🎁</div>
                <Title order={4} size="h5" className="mb-2">
                  Enjoy Rewards
                </Title>
                <Text size="sm" c="dimmed">
                  Access exclusive content, Buzz credits, and special perks
                </Text>
              </div>
            </div>
          </div>
        </Stack>
      </Container>
    </>
  );
}
