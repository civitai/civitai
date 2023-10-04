import { Button, Container, Group, Paper, Stack, Text } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconEyeOff, IconKey } from '@tabler/icons-react';
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
            <Link href={`/login?returnUrl=${router.asPath}`}>
              <Button leftIcon={<IconKey />}>Log in to view</Button>
            </Link>
          </Group>
        </Stack>
      </Paper>
    </Container>
  );
}
