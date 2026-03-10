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
import { IconCircleCheck, IconCopy, IconGift, IconTicket } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { CopyButton } from '~/components/CopyButton/CopyButton';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Meta } from '~/components/Meta/Meta';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import animationClasses from '~/libs/animations.module.scss';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { trpc } from '~/utils/trpc';

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

export default function CoinbaseCodeSuccess() {
  const router = useRouter();
  const { orderId } = router.query as { orderId?: string | null };

  const { data: codeData } = trpc.redeemableCode.getCodeByOrderId.useQuery(
    { orderId: orderId! },
    {
      enabled: !!orderId,
      refetchInterval: (data) => {
        if (data) return false;
        return 3000;
      },
    }
  );

  const codeReady = !!codeData;

  return (
    <>
      <Meta title="Code Purchase Complete | Civitai" deIndex />
      <Container size="xs" mb="lg">
        <Stack>
          <Alert radius="sm" color="green" className="z-10">
            <Group gap="xs" wrap="nowrap" justify="center">
              <ThemeIcon color="green" size="lg">
                <IconCircleCheck />
              </ThemeIcon>
              <Title order={2}>Payment Complete!</Title>
            </Group>
          </Alert>
          <Center className={animationClasses.jelloFall}>
            <EdgeMedia src="41585279-0f0a-4717-174c-b5f02e157f00" width={256} />
          </Center>
          <Title order={1} ta="center">
            Thank you!
          </Title>

          {codeReady ? (
            <>
              <Text size="lg" ta="center" mb="lg">
                Your redeemable code is ready! Copy it below or use the redeem button to activate it.
              </Text>
              <Alert color="green" icon={<IconCircleCheck size={20} />}>
                <Stack gap="xs">
                  <Text fw={500}>Your code is ready!</Text>
                  <CopyButton value={codeData.code}>
                    {({ copy, copied }) => (
                      <Tooltip label="Copied!" opened={copied}>
                        <Code
                          style={{ cursor: 'pointer', height: 'auto', fontSize: '1.25rem' }}
                          onClick={copy}
                          pr={2}
                        >
                          {codeData.code} <IconCopy size={16} style={{ verticalAlign: 'middle' }} />
                        </Code>
                      </Tooltip>
                    )}
                  </CopyButton>
                  <Text size="sm" c="dimmed">
                    {codeData.type === 'Buzz'
                      ? `${codeData.unitValue.toLocaleString()} Buzz`
                      : `${codeData.unitValue}-month Membership`}
                  </Text>
                </Stack>
              </Alert>
            </>
          ) : (
            <>
              <Text size="lg" ta="center" mb="lg">
                Your crypto payment is being processed. Once confirmed, your redeemable code will
                appear below. Most transactions complete within a few minutes, but in rare cases it
                may take a few hours.
              </Text>

              <Alert color="blue" icon={<Loader size={20} />}>
                <Text fw={500}>Waiting for blockchain confirmation...</Text>
                <Text size="sm" c="dimmed">
                  Your redeemable code will appear here once the payment is confirmed.
                </Text>
              </Alert>
            </>
          )}

          {orderId && !codeReady && (
            <Alert>
              <Stack>
                <Text>
                  If you haven&rsquo;t received your code within 2 hours, please contact support
                  with the following Order ID:
                </Text>
                <CopyButton value={orderId}>
                  {({ copy, copied }) => (
                    <Tooltip label="Copied!" opened={copied}>
                      <Code style={{ cursor: 'pointer', height: 'auto' }} onClick={copy} pr={2}>
                        {orderId}
                      </Code>
                    </Tooltip>
                  )}
                </CopyButton>
              </Stack>
            </Alert>
          )}

          <Stack>
            <Button
              component={Link}
              href={codeReady ? `/redeem-code?code=${codeData.code}` : '/redeem-code'}
              size="md"
              color="blue"
              leftSection={<IconTicket size={20} />}
            >
              Redeem a Code
            </Button>
            <Button
              component={Link}
              href="/gift-cards?vendor=crypto"
              size="md"
              variant="light"
              leftSection={<IconGift size={20} />}
            >
              Buy More Codes
            </Button>
          </Stack>
        </Stack>
      </Container>
    </>
  );
}
