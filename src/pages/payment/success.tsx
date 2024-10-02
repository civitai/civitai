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
import { IconCircleCheck, IconLayoutDashboard, IconRosette } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Meta } from '~/components/Meta/Meta';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { enterFall, jelloVertical } from '~/libs/animations';

export default function PaymentSuccess() {
  const router = useRouter();
  const { cid } = router.query as { cid: string };
  const { customerId, refresh } = useCurrentUser() ?? {};

  // Only run once - otherwise we'll get an infinite loop
  useEffect(() => {
    refresh?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (cid !== customerId?.slice(-8)) {
    router.replace('/');
    return null;
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
        </Stack>
      </Container>
    </>
  );
}
