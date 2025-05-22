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
} from '@mantine/core';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconCircleCheck, IconLayoutDashboard, IconRosette } from '@tabler/icons-react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Meta } from '~/components/Meta/Meta';
import { enterFall, jelloVertical } from '~/libs/animations';
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

export default function NOWPaymentsSuccess() {
  // TODO: @nowpayments. We need to determine what this looks like & what params we get to confirm buzz transactions and the like.
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
              <Title order={2}>Payment Complete!</Title>
            </Group>
          </Alert>
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
            <Button component={Link} href="/models" size="md" leftIcon={<IconLayoutDashboard />}>
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
        </Stack>
      </Container>
    </>
  );
}
