import {
  Alert,
  Button,
  Center,
  Container,
  Group,
  Stack,
  Text,
  ThemeIcon,
  Title,
} from '@mantine/core';
import { IconBarbell, IconBolt, IconBrush, IconCircleCheck } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Meta } from '~/components/Meta/Meta';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
  resolver: async ({ session, ctx }) => {
    if (!session) {
      return {
        redirect: {
          destination: `/login?returnUrl=${encodeURIComponent(ctx.resolvedUrl)}`,
          permanent: false,
        },
      };
    }
  },
});

export default function EmerchantPaySuccess() {
  const router = useRouter();
  const { orderId, error } = router.query as {
    orderId?: string | null;
    error?: string | null;
  };

  const hasError = error === 'failed';

  return (
    <>
      <Meta
        title={hasError ? 'Payment Failed | Civitai' : 'Successful Payment | Civitai'}
        deIndex
      />
      <Container size="xs" mb="lg">
        <Stack>
          <Alert radius="sm" color={hasError ? 'red' : 'green'} className="z-10">
            <Group gap="xs" wrap="nowrap" justify="center">
              <ThemeIcon color={hasError ? 'red' : 'green'} size="lg">
                <IconCircleCheck />
              </ThemeIcon>
              <Title order={2}>{hasError ? 'Payment Failed' : 'Payment Complete!'}</Title>
            </Group>
          </Alert>

          {!hasError && (
            <Center>
              <EdgeMedia src="41585279-0f0a-4717-174c-b5f02e157f00" width={256} />
            </Center>
          )}

          <Title order={1} ta="center">
            {hasError ? 'Something went wrong 😞' : 'Thank you! 🎉'}
          </Title>

          <Text size="lg" align="center" mb="lg">
            {hasError
              ? 'We encountered an issue processing your payment. Please try again or contact support if the problem persists.'
              : 'Thank you so much for your support! Your payment has been processed and your Buzz should be available in your account shortly.'}
          </Text>

          {orderId && (
            <Alert>
              <Stack>
                <Text>
                  If you have any issues with your order, please contact support with the following
                  Order ID: <strong>{orderId}</strong>
                </Text>
              </Stack>
            </Alert>
          )}

          <Stack>
            {!hasError && (
              <>
                <Button
                  component={Link}
                  href="/purchase/buzz"
                  size="md"
                  color="yellow.8"
                  leftSection={<IconBolt />}
                >
                  Buy More
                </Button>
                <Button component={Link} href="/generate" size="md" leftSection={<IconBrush />}>
                  Generate
                </Button>
                <Button
                  component={Link}
                  href="/models/train"
                  size="md"
                  color="green"
                  leftSection={<IconBarbell />}
                >
                  Train
                </Button>
              </>
            )}
            {hasError && (
              <Button component={Link} href="/purchase/buzz" size="md" color="blue">
                Try Again
              </Button>
            )}
          </Stack>
        </Stack>
      </Container>
    </>
  );
}
