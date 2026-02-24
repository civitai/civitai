import {
  Alert,
  Button,
  Center,
  Code,
  Container,
  Group,
  Loader,
  Stack,
  Text,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconClock,
  IconGift,
  IconTicket,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { CopyButton } from '~/components/CopyButton/CopyButton';
import { useCodeOrderStatus } from '~/components/Coinbase/util';
import { Meta } from '~/components/Meta/Meta';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

export const getServerSideProps = createServerSideProps({
  useSession: true,
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

export default function CoinbaseCodeSuccess() {
  const router = useRouter();
  const { orderId } = router.query as { orderId?: string };
  const { order, isError, timedOut } = useCodeOrderStatus(orderId);

  if (!orderId) {
    return (
      <>
        <Meta title="Order Not Found | Civitai" deIndex />
        <Container size="xs" mb="lg">
          <Alert color="red" title="Order Not Found">
            <Text>No order ID was provided. Please check your link and try again.</Text>
          </Alert>
        </Container>
      </>
    );
  }

  const isCompleted = order?.status === 'completed';
  const showPending = !isCompleted && !isError && !timedOut;
  const showError = isError || timedOut;

  return (
    <>
      <Meta title="Redeemable Code Purchase | Civitai" deIndex />
      <Container size="xs" mb="lg">
        <Stack gap="lg">
          {showPending && (
            <>
              <Alert radius="sm" color="blue">
                <Group gap="xs" wrap="nowrap" justify="center">
                  <ThemeIcon color="blue" size="lg">
                    <IconClock />
                  </ThemeIcon>
                  <Title order={2}>Processing Payment...</Title>
                </Group>
              </Alert>
              <Center>
                <Loader size="xl" />
              </Center>
              <Text size="lg" ta="center">
                Your crypto payment is being confirmed. This typically takes a few minutes. This
                page will automatically update once your code is ready.
              </Text>
              <OrderIdDisplay orderId={orderId} />
            </>
          )}

          {showError && (
            <>
              <Alert radius="sm" color="yellow" icon={<IconAlertTriangle size={20} />}>
                <Title order={3}>Still Processing</Title>
                <Text size="sm" mt="xs">
                  Your payment may still be processing. Crypto transactions can sometimes take
                  longer than expected. Please save your Order ID and check back later, or contact
                  support if your code does not appear within a few hours.
                </Text>
              </Alert>
              <OrderIdDisplay orderId={orderId} />
              <Button component={Link} href="/gift-cards?vendor=crypto" variant="light" size="md">
                Back to Gift Cards
              </Button>
            </>
          )}

          {isCompleted && order.redeemableCode && (
            <>
              <Alert radius="sm" color="green">
                <Group gap="xs" wrap="nowrap" justify="center">
                  <ThemeIcon color="green" size="lg">
                    <IconCircleCheck />
                  </ThemeIcon>
                  <Title order={2}>Your Code is Ready!</Title>
                </Group>
              </Alert>
              <Center>
                <ThemeIcon size={80} radius="xl" color="green" variant="light">
                  <IconTicket size={48} />
                </ThemeIcon>
              </Center>
              {order.type && order.unitValue && (
                <Text size="lg" ta="center" fw={500}>
                  {order.type === 'Buzz'
                    ? `${order.unitValue.toLocaleString()} Buzz Redeemable Code`
                    : `Membership - ${order.unitValue} Month${order.unitValue > 1 ? 's' : ''}`}
                </Text>
              )}
              <Alert color="green" variant="light" p="xl">
                <Stack align="center" gap="md">
                  <Text size="sm" c="dimmed">
                    Your redeemable code:
                  </Text>
                  <CopyButton value={order.redeemableCode}>
                    {({ copy, copied }) => (
                      <Tooltip label="Copied!" opened={copied}>
                        <Code
                          role="button"
                          tabIndex={0}
                          aria-label="Copy redeemable code to clipboard"
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') copy();
                          }}
                          style={{
                            cursor: 'pointer',
                            fontSize: '1.5rem',
                            padding: '12px 24px',
                            letterSpacing: '2px',
                          }}
                          onClick={copy}
                        >
                          {order.redeemableCode}
                        </Code>
                      </Tooltip>
                    )}
                  </CopyButton>
                  <Text size="xs" c="dimmed">
                    Click the code to copy it
                  </Text>
                </Stack>
              </Alert>
              <Text ta="center" c="dimmed">
                Share this code with someone as a gift, or redeem it yourself.
              </Text>
              <Stack gap="sm">
                <Button
                  component={Link}
                  href="/redeem-code"
                  size="md"
                  leftSection={<IconGift size={20} />}
                >
                  Redeem Code
                </Button>
                <Button component={Link} href="/gift-cards?vendor=crypto" variant="light" size="md">
                  Buy Another
                </Button>
              </Stack>
            </>
          )}
        </Stack>
      </Container>
    </>
  );
}

function OrderIdDisplay({ orderId }: { orderId: string }) {
  return (
    <Alert>
      <Stack>
        <Text>Your Order ID for reference:</Text>
        <CopyButton value={orderId}>
          {({ copy, copied }) => (
            <Tooltip label="Copied!" opened={copied}>
              <Code
                role="button"
                tabIndex={0}
                aria-label="Copy order ID to clipboard"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') copy();
                }}
                style={{ cursor: 'pointer', height: 'auto' }}
                onClick={copy}
                pr={2}
              >
                {orderId}
              </Code>
            </Tooltip>
          )}
        </CopyButton>
      </Stack>
    </Alert>
  );
}
