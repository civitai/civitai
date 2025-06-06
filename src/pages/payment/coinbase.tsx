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
  Tooltip,
  Code,
} from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconBarbell, IconBolt, IconBrush, IconCircleCheck } from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Meta } from '~/components/Meta/Meta';
import { createServerSideProps } from '~/server/utils/server-side-helpers';
import { CopyButton } from '~/components/CopyButton/CopyButton';
import { useRouter } from 'next/router';
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

export default function CoinbaseSuccess() {
  const router = useRouter();
  const { orderId } = router.query as { orderId?: string | null };

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
            Thank you so much for your support! It might take a few minutes for your crypto to go
            through. Your buzz will be available in your account shortly after that.
          </Text>
          {orderId && (
            <Alert>
              <Stack>
                <Text>
                  If you have any issues with your order, please contact support with the following
                  Order ID:{' '}
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
