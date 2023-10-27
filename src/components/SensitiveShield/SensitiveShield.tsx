import { Button, Container, Group, Paper, Stack, Text } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconEyeOff, IconKey } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useState } from 'react';

export function SensitiveShield({
  children,
  enabled = true,
}: {
  children?: JSX.Element;
  enabled?: boolean;
}) {
  const router = useRouter();
  const [accepted, setAccepted] = useState(false);
  if (children && (!enabled || accepted)) return children;

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
            {children ? (
              <Button leftIcon={<IconEyeOff />} onClick={() => setAccepted(true)}>
                {`I'm over 18`}
              </Button>
            ) : (
              <Button
                component={NextLink}
                href={`/login?returnUrl=${router.asPath}`}
                leftIcon={<IconKey />}
              >
                Log in to view
              </Button>
            )}
          </Group>
        </Stack>
      </Paper>
    </Container>
  );
}
