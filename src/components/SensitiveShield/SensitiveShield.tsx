import { Button, Container, Group, Paper, Stack, Text } from '@mantine/core';
import { IconEyeOff, IconKey } from '@tabler/icons';
import Link from 'next/link';
import { useRouter } from 'next/router';

export function SensitiveShield() {
  const router = useRouter();
  return (
    <Container size="xs">
      <Paper p="xl" radius="md" withBorder>
        <Stack align="center">
          <IconEyeOff size={56} />
          <Text size="xl" weight={500}>
            Sensitive Content
          </Text>
          <Text>This content has been marked as NSFW</Text>
          <Group>
            <Button
              component={Link}
              href={`/login?returnUrl=${router.asPath}`}
              leftIcon={<IconKey />}
            >
              Log in to view
            </Button>
          </Group>
        </Stack>
      </Paper>
    </Container>
  );
}
