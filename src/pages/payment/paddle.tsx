import {
  Container,
  Stack,
  Title,
  Text,
  Alert,
  ThemeIcon,
  Group,
  Button,
  Center,
  Loader,
} from '@mantine/core';
import { NextLink } from '@mantine/next';
import { CheckoutEventsData } from '@paddle/paddle-js';
import { IconCircleCheck, IconLayoutDashboard, IconRosette } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useState } from 'react';
import { NotFound } from '~/components/AppLayout/NotFound';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Meta } from '~/components/Meta/Meta';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { enterFall, jelloVertical } from '~/libs/animations';
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
      paddle.Checkout.open({
        settings: {
          theme: 'dark',
        },
        transactionId: transactionId,
      });

      emitter.on('checkout.completed', onCheckoutComplete);
      emitter.on('checkout.closed', onCheckoutClosed);
    }

    return () => {
      emitter.off('checkout.completed', onCheckoutComplete);
      emitter.off('checkout.closed', onCheckoutClosed);
    };
  }, [transactionId, paddle, currentUser, emitter, onCheckoutComplete, onCheckoutClosed]);

  if (!transactionId) {
    return <NotFound />;
  }

  return (
    <>
      <Meta title="Successful Payment | Civitai" deIndex />
      <Container size="xs" mb="lg">
        <Stack>
          <Alert radius="sm" color="green" sx={{ zIndex: 10 }}>
            <Group spacing="xs" noWrap position="center">
              <ThemeIcon color="green" size="lg">
                <IconCircleCheck />
              </ThemeIcon>
              <Title order={2}>Complete your Payment</Title>
            </Group>
          </Alert>
          {!closed && !success && (
            <Center>
              <Loader />
            </Center>
          )}
          {closed && !success && (
            <Alert radius="sm" color="red">
              <Group spacing="xs" noWrap position="center">
                <ThemeIcon color="red" size="lg">
                  <IconCircleCheck />
                </ThemeIcon>
                <Title order={2}>Payment Cancelled</Title>
              </Group>
              <Text size="lg" align="center">
                You may refresh the page if you wish to try again.
              </Text>
            </Alert>
          )}
          {success && (
            <>
              <Center
                sx={{
                  // animation: `${jelloVerical} 2s 1s ease-in-out`,
                  animationName: `${enterFall}, ${jelloVertical}`,
                  animationDuration: `1.5s, 2s`,
                  animationDelay: `0s, 1.5s`,
                  animationIterationCount: '1, 1',
                }}
              >
                <EdgeMedia src="41585279-0f0a-4717-174c-b5f02e157f00" width={256} />
              </Center>
              <Title order={1} align="center">
                Thank you! 🎉
              </Title>
              <Text size="lg" align="center" mb="lg">
                {`Thank you so much for your support! Your perks may take a few moments* to come in to effect, but our love for you is instant.`}
              </Text>

              <Group grow>
                <Button
                  component={NextLink}
                  href="/models"
                  size="md"
                  leftIcon={<IconLayoutDashboard />}
                >
                  View Models
                </Button>
                <Button
                  variant="light"
                  component={NextLink}
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
