import {
  Container,
  Stack,
  Title,
  Text,
  Alert,
  ThemeIcon,
  Group,
  Button,
  Code,
  Loader,
  Tooltip,
} from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconCircleCheck, IconClock, IconExclamationMark } from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { CopyButton } from '~/components/CopyButton/CopyButton';
import { useRouter } from 'next/router';
import { useGetZkp2pTransactionStatus } from '~/components/ZKP2P/util';
import animationClasses from '~/libs/animations.module.scss';

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
      <Container size="xs" mb="lg">
        <Stack>
          <Alert radius="sm" color={statusContent.color} className="z-10">
            <Group gap="xs" wrap="nowrap" justify="center">
              <ThemeIcon color={statusContent.color} size="lg" radius="xl" variant="light">
                {!isSuccess && !isFailed ? (
                  <Loader size="sm" color={statusContent.color} />
                ) : (
                  <statusContent.icon size={16} />
                )}
              </ThemeIcon>
              <Text weight={500}>{statusContent.title}</Text>
            </Group>
          </Alert>

          <Stack align="center" gap="lg">
            <div className={animationClasses.wiggle}>
              <EdgeMedia
                src="cf3edabf-6e48-4a7b-82db-0e8bae4c7025"
                alt="Civitai mascot - celebrating with buzz"
                width={200}
              />
            </div>

            <Stack align="center" gap="xs">
              <Title order={1} size="h2" ta="center">
                {statusContent.title}
              </Title>
              <Text ta="center" color="dimmed" maw={400}>
                {statusContent.message}
              </Text>

              {key && !isSuccess && (
                <Group gap="xs" mt="sm">
                  <Text size="sm" color="dimmed">
                    Transaction ID:
                  </Text>
                  <CopyButton value={key}>
                    {({ copy, copied }) => (
                      <Tooltip label={copied ? 'Copied' : 'Copy transaction ID'}>
                        <Code
                          onClick={copy}
                          style={{ cursor: 'pointer' }}
                          color={copied ? 'green' : 'blue'}
                        >
                          {key.slice(0, 8)}...{key.slice(-8)}
                        </Code>
                      </Tooltip>
                    )}
                  </CopyButton>
                </Group>
              )}
            </Stack>

            {isSuccess && (
              <Stack align="center" gap="sm">
                <Text ta="center" size="sm" color="dimmed">
                  Your USDC has been received and is ready to use!
                </Text>
                <Group gap="sm">
                  <Button
                    component={Link}
                    href="/user/buzz-dashboard"
                    variant="light"
                    leftIcon={<IconCircleCheck size={16} />}
                  >
                    View Buzz Dashboard
                  </Button>
                  <Button component={Link} href="/" variant="default">
                    Return Home
                  </Button>
                </Group>
              </Stack>
            )}

            {!isSuccess && !isFailed && (
              <Stack align="center" gap="sm">
                <Text ta="center" size="sm" color="dimmed">
                  Please wait while we confirm your payment. This page will update automatically.
                </Text>
                <Button onClick={() => window.location.reload()} variant="light" size="sm">
                  Refresh Status
                </Button>
              </Stack>
            )}

            {isFailed && (
              <Stack align="center" gap="sm">
                <Text ta="center" size="sm" color="dimmed">
                  If you believe this is an error, please contact support.
                </Text>
                <Group gap="sm">
                  <Button component={Link} href="/support" variant="light">
                    Contact Support
                  </Button>
                  <Button component={Link} href="/" variant="default">
                    Return Home
                  </Button>
                </Group>
              </Stack>
            )}
          </Stack>
        </Stack>
      </Container>
    </>
  );
}
