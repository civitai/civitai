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
import { IconBarbell, IconBolt, IconBrush, IconCircleCheck } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useGetTransactionStatus } from '~/components/Coinbase/util';
import { CopyButton } from '~/components/CopyButton/CopyButton';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Meta } from '~/components/Meta/Meta';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import animationClasses from '~/libs/animations.module.scss';
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

export default function CoinbaseSuccess() {
  const router = useRouter();
  const { orderId, key } = router.query as { orderId?: string | null; key?: string | null };
  const { isFailed, isSuccess } = useGetTransactionStatus(key);

  return (
    <>
      <Meta title="Successful Payment | Civitai" deIndex />
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
            Thank you! 🎉
          </Title>
          <Text size="lg" align="center" mb="lg">
            Thank you so much for your support! Most transactions complete within a few minutes, but
            in rare cases it may take a few hours for your crypto to process. Your Buzz will be
            added to your account as soon as it’s confirmed.
          </Text>
          {key && (
            <Alert color={isFailed ? 'red' : isSuccess ? 'green' : 'blue'} radius="sm">
              <Stack>
                {!isFailed && !isSuccess ? (
                  <Stack align="center">
                    <Text className="text-center">
                      Your transaction is being processed. Please wait a few minutes for it to
                      complete.
                    </Text>
                    <Loader />
                  </Stack>
                ) : isSuccess ? (
                  <Text className="text-center">
                    Your transaction has been successfully completed! You should have recevied your
                    Buzz!
                  </Text>
                ) : (
                  <>
                    <Text>
                      Your transaction has <span className="font-bold">failed to be processed</span>
                      . You may contact support with the following ticket number:
                    </Text>
                    <CopyButton value={key}>
                      {({ copy, copied }) => (
                        <Tooltip label="Copied!" opened={copied}>
                          <Code style={{ cursor: 'pointer', height: 'auto' }} onClick={copy} pr={2}>
                            {key}
                          </Code>
                        </Tooltip>
                      )}
                    </CopyButton>
                  </>
                )}
              </Stack>
            </Alert>
          )}
          {orderId && (
            <Alert>
              <Stack>
                <Text>
                  If your Buzz hasn’t appeared in your account within 2 hours, please contact
                  support with the following Order ID:{' '}
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
              href="/purchase/buzz"
              size="md"
              color="yellow.8"
              leftIcon={<IconBolt />}
            >
              Buy More
            </Button>
            <Button component={Link} href="/generate" size="md" leftIcon={<IconBrush />}>
              Generate
            </Button>
            <Button
              component={Link}
              href="/models/train"
              size="md"
              color="green"
              leftIcon={<IconBarbell />}
            >
              Train
            </Button>
          </Stack>{' '}
        </Stack>
      </Container>
    </>
  );
}
