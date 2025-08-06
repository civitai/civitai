import {
  Container,
  Stack,
  Title,
  Text,
  ThemeIcon,
  Group,
  Button,
  Code,
  Loader,
  Tooltip,
  Card,
  Grid,
  Paper,
} from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import {
  IconCircleCheck,
  IconClock,
  IconExclamationMark,
  IconShieldCheck,
  IconBolt,
  IconArrowRight,
  IconHome,
  IconDashboard,
} from '@tabler/icons-react';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { CopyButton } from '~/components/CopyButton/CopyButton';
import { useRouter } from 'next/router';
import { useGetZkp2pTransactionStatus } from '~/components/ZKP2P/util';
import { BuzzFeatures } from '~/components/Buzz/BuzzFeatures';

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

export default function ZkP2PSuccess() {
  const router = useRouter();
  const { key } = router.query as { orderId?: string | null; key?: string | null };
  const { status: transactionStatus } = useGetZkp2pTransactionStatus(key);

  const isSuccess = transactionStatus?.status === 'Complete';
  const isFailed =
    transactionStatus?.status === 'RampFailed' || transactionStatus?.status === 'SweepFailed';

  function getStatusContent() {
    if (isSuccess) {
      return {
        color: 'green',
        icon: IconCircleCheck,
        title: 'Payment Successful!',
        message: 'Your ZKP2P payment has been processed successfully.',
      };
    }

    if (isFailed) {
      return {
        color: 'red',
        icon: IconExclamationMark,
        title: 'Payment Failed',
        message: 'There was an issue processing your ZKP2P payment. Please try again.',
      };
    }

    return {
      color: 'yellow',
      icon: IconClock,
      title: 'Payment Processing',
      message: 'Your ZKP2P payment is being processed. This may take a few minutes.',
    };
  }

  const statusContent = getStatusContent();

  return (
    <>
      <Meta title="ZKP2P Payment Status | Civitai" deIndex />
      <Container size="md" py="xl">
        <Stack gap="xl">
          {/* Main Status Display */}
          <Card padding="lg" radius="md">
            <Stack align="center" gap="lg">
              <ThemeIcon size={80} radius="xl" variant="light" color={statusContent.color}>
                {!isSuccess && !isFailed ? (
                  <Loader size="xl" color={statusContent.color} />
                ) : (
                  <statusContent.icon size={40} />
                )}
              </ThemeIcon>

              <Stack align="center" gap="xs">
                <Title order={1} size="h2" ta="center">
                  {statusContent.title}
                </Title>
                <Text ta="center" c="dimmed" maw={500} lh={1.5}>
                  {statusContent.message}
                </Text>
              </Stack>

              {key && !isSuccess && (
                <Group gap="xs" mt="sm">
                  <Text size="sm" c="dimmed" fw={500}>
                    Transaction ID:
                  </Text>
                  <CopyButton value={key}>
                    {({ copy, copied }) => (
                      <Tooltip label={copied ? 'Copied' : 'Copy transaction ID'}>
                        <Code
                          onClick={copy}
                          style={{ cursor: 'pointer' }}
                          c={copied ? 'green' : 'blue'}
                          fw={500}
                        >
                          {key.slice(0, 8)}...{key.slice(-8)}
                        </Code>
                      </Tooltip>
                    )}
                  </CopyButton>
                </Group>
              )}

              {!isSuccess && !isFailed && (
                <Stack align="center" gap="sm" mt="md">
                  <Text ta="center" size="sm" c="dimmed" maw={400}>
                    Please wait while we confirm your payment on the blockchain. This page will
                    update automatically when complete.
                  </Text>
                  <Button
                    onClick={() => window.location.reload()}
                    variant="light"
                    size="sm"
                    leftSection={<IconArrowRight size={16} />}
                  >
                    Refresh Status
                  </Button>
                </Stack>
              )}
            </Stack>
          </Card>
          {/* Action Buttons Section */}
          {isSuccess && (
            <Card padding="lg" radius="md">
              <Stack align="center" gap="lg">
                <Group gap="sm" wrap="nowrap">
                  <ThemeIcon size="sm" color="green" variant="light" radius="xl">
                    <IconShieldCheck size={16} />
                  </ThemeIcon>
                  <Text size="md" fw={500} c="green.7">
                    Your USDC has been received and converted to Buzz!
                  </Text>
                </Group>

                <Group gap="md" justify="center">
                  <Button
                    component={Link}
                    href="/user/buzz-dashboard"
                    variant="filled"
                    color="yellow"
                    size="md"
                    leftSection={<IconDashboard size={18} />}
                    fw={600}
                  >
                    View Buzz Dashboard
                  </Button>
                  <Button
                    component={Link}
                    href="/"
                    variant="light"
                    color="gray"
                    size="md"
                    leftSection={<IconHome size={18} />}
                  >
                    Return Home
                  </Button>
                </Group>
              </Stack>
            </Card>
          )}

          {isFailed && (
            <Card padding="lg" radius="md">
              <Stack align="center" gap="lg">
                <Text ta="center" size="md" c="dimmed" maw={400}>
                  If you believe this is an error or need assistance, our support team is here to
                  help.
                </Text>

                <Group gap="md" justify="center">
                  <Button component={Link} href="/support" variant="filled" color="blue" size="md">
                    Contact Support
                  </Button>
                  <Button
                    component={Link}
                    href="/"
                    variant="light"
                    color="gray"
                    size="md"
                    leftSection={<IconHome size={18} />}
                  >
                    Return Home
                  </Button>
                </Group>
              </Stack>
            </Card>
          )}

          {/* Buzz Features Section - Show for all statuses */}
          <Grid>
            <Grid.Col span={{ base: 12, md: isSuccess ? 6 : 12 }}>
              <BuzzFeatures
                title="What You Can Do With Buzz"
                subtitle="Explore all the amazing features available with your Buzz"
                compact={!isSuccess}
              />
            </Grid.Col>

            {isSuccess && (
              <Grid.Col span={{ base: 12, md: 6 }}>
                <Card padding="lg" radius="md" h="100%">
                  <Stack gap="md" h="100%">
                    <Group gap="sm">
                      <ThemeIcon size="lg" color="green" variant="light" radius="xl">
                        <IconBolt size={20} />
                      </ThemeIcon>
                      <div>
                        <Title order={3} size="lg">
                          Ready to Explore?
                        </Title>
                        <Text size="sm" c="dimmed">
                          Your Buzz is ready to use!
                        </Text>
                      </div>
                    </Group>

                    <Stack gap="sm" mt="auto">
                      <Button
                        component={Link}
                        href="/images"
                        variant="light"
                        color="blue"
                        fullWidth
                        leftSection={<IconArrowRight size={16} />}
                      >
                        Browse & Tip Artists
                      </Button>
                      <Button
                        component={Link}
                        href="/models"
                        variant="light"
                        color="violet"
                        fullWidth
                        leftSection={<IconArrowRight size={16} />}
                      >
                        Explore Models
                      </Button>
                      <Button
                        component={Link}
                        href="/generate"
                        variant="light"
                        color="orange"
                        fullWidth
                        leftSection={<IconArrowRight size={16} />}
                      >
                        Start Generating
                      </Button>
                    </Stack>
                  </Stack>
                </Card>
              </Grid.Col>
            )}
          </Grid>

          {/* Security Notice */}
          <Paper
            p="md"
            radius="md"
            style={{
              backgroundColor:
                'light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))',
            }}
          >
            <Group gap="sm" wrap="nowrap">
              <ThemeIcon size="sm" color="blue" variant="light" radius="xl">
                <IconShieldCheck size={16} />
              </ThemeIcon>
              <div style={{ flex: 1 }}>
                <Text size="sm" fw={500}>
                  Secure Payment
                </Text>
                <Text size="xs" c="dimmed">
                  Your payment was processed securely using zero-knowledge proofs via ZKP2P
                  protocol.
                </Text>
              </div>
            </Group>
          </Paper>
        </Stack>
      </Container>
    </>
  );
}
