import { Container, Stack, Title, Text, Group, Button, Center, Loader } from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import type { CheckoutEventsData } from '@paddle/paddle-js';
import { IconCancel, IconLayoutDashboard, IconRosette } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Meta } from '~/components/Meta/Meta';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { usePaddle } from '~/providers/PaddleProvider';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  useSSG: true,
  resolver: async ({ session, ctx }) => {
    if (!session)
      return {
        redirect: {
          destination: `/login?returnUrl=${encodeURIComponent(ctx.resolvedUrl)}`,
          permanent: false,
        },
      };
  },
});

export default function CompletePaddlePaymentTransaction() {
  const router = useRouter();
  const { _ptxn: transactionId } = router.query as { _ptxn: string };
  const [success, setSuccess] = useState(false);
  const [closed, setClosed] = useState(false);
  const { paddle, emitter } = usePaddle();
  const currentUser = useCurrentUser();

  const onCheckoutComplete = useCallback(
    (data?: CheckoutEventsData) => {
      if (transactionId && data?.transaction_id === transactionId) {
        setSuccess(true);
      }
    },
    [transactionId]
  );
  const onCheckoutClosed = useCallback(() => {
    setClosed(true);
  }, []);

  // Only run once - otherwise we'll get an infinite loop
  useEffect(() => {
    if (paddle && transactionId && currentUser) {
      emitter.on('checkout.completed', onCheckoutComplete);
      emitter.on('checkout.closed', onCheckoutClosed);
    }

    return () => {
      emitter?.off('checkout.completed', onCheckoutComplete);
      emitter?.off('checkout.closed', onCheckoutClosed);
    };
  }, [transactionId, paddle, currentUser, emitter, onCheckoutComplete, onCheckoutClosed]);

  if (!transactionId) {
    return <NotFound />;
  }

  return (
    <>
      <Meta title="Successful Payment | Civitai" deIndex />
      <Container size="xs" mb="lg">
        <Stack align="center">
          <Title order={1} className="text-center" mb="xl">
            Complete your Payment
          </Title>
          {!closed && !success && (
            <Center>
              <Loader />
            </Center>
          )}
          {closed && !success && (
            <Stack align="center">
              <IconCancel color="red" size={32} />
              <Title order={3} className="text-center">
                Looks like you canceled the payment
              </Title>
              <Text align="center">
                We were unable to complete your transaction process because you canceled the
                payment.
              </Text>
              <Text>You may refresh the page if you wish to try again.</Text>
            </Stack>
          )}
          {success && (
            <>
              <Center
                sx={{
                  // animation: `${jelloVerical} 2s 1s ease-in-out`,
                  animationName: `enterFall, jelloVertical`,
                  animationDuration: `1.5s, 2s`,
                  animationDelay: `0s, 1.5s`,
                  animationIterationCount: '1, 1',
                }}
              >
                <EdgeMedia src="41585279-0f0a-4717-174c-b5f02e157f00" width={256} />
              </Center>
              <Title order={1} className="text-center">
                Thank you! 🎉
              </Title>
              <Text size="lg" align="center" mb="lg">
                {`Thank you so much for your support! Your perks may take a few moments* to come in to effect, but our love for you is instant.`}
              </Text>

              <Group grow>
                <Button
                  component={Link}
                  href="/models"
                  size="md"
                  leftIcon={<IconLayoutDashboard />}
                >
                  View Models
                </Button>
                <Button
                  variant="light"
                  component={Link}
                  href="/user/account"
                  size="md"
                  rightIcon={<IconRosette />}
                >
                  Customize Profile
                </Button>
              </Group>
              <Text
                size="xs"
                color="dimmed"
              >{`*Cosmetics and other perks should be delivered within 2-3 minutes, but you may need to refresh the site before you're able to see them in your profile.`}</Text>
            </>
          )}
        </Stack>
      </Container>
    </>
  );
}
