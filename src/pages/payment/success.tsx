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
import { NextLink } from '@mantine/next';
import { IconCircleCheck, IconLayoutDashboard, IconRosette } from '@tabler/icons';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { enterFall, jelloVerical } from '~/libs/animations';
import { reloadSession } from '~/utils/next-auth-helpers';

export default function PaymentSuccess() {
  const router = useRouter();
  const { cid } = router.query as { cid: string };
  const { customerId } = useCurrentUser() ?? {};

  useEffect(() => {
    reloadSession();
  }, []);

  if (cid !== customerId?.slice(-8)) {
    router.replace('/');
    return null;
  }

  // console.log({ currentUser });
  return (
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
            animationName: `${enterFall}, ${jelloVerical}`,
            animationDuration: `1.5s, 2s`,
            animationDelay: `0s, 1.5s`,
            animationIterationCount: '1, 1',
          }}
        >
          <EdgeImage src="41585279-0f0a-4717-174c-b5f02e157f00" width={256} />
        </Center>
        <Title order={1} align="center">
          Thank you! 🎉
        </Title>
        <Text size="lg" align="center" mb="lg">
          {`Thank you so much for your support! Your perks may take a few moments* to come in to effect, but our love for you is instant.`}
        </Text>

        <Group grow>
          <Button component={NextLink} href="/" size="md" leftIcon={<IconLayoutDashboard />}>
            View Models
          </Button>
          <Button
            variant="light"
            component={NextLink}
            href="/user/account"
            size="md"
            rightIcon={<IconRosette />}
          >
            Edit Profile
          </Button>
        </Group>
        <Text
          size="xs"
          color="dimmed"
        >{`*Cosmetics and other perks should be delivered within 2-3 minutes, but you may need to refresh the site before you're able to see them in your profile.`}</Text>
      </Stack>
    </Container>
  );
}
