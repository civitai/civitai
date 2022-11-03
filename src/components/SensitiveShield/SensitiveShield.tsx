import { Container, Paper, Stack, Text } from '@mantine/core';
import { NextLink } from '@mantine/next';
import { IconEyeOff } from '@tabler/icons';

export function SensitiveShield({ redirectTo }: Props) {
  return (
    <Container size="xs">
      <Paper p="xl" radius="md" withBorder>
        <Stack align="center">
          <IconEyeOff size={56} />
          <Text size="xl" weight={500}>
            Sensitive Content
          </Text>
          <Text>
            This content has been marked as NSFW, please{' '}
            <Text component={NextLink} variant="link" href={`/login?returnUrl=${redirectTo}`}>
              log in
            </Text>{' '}
            if you wish to continue
          </Text>
        </Stack>
      </Paper>
    </Container>
  );
}

type Props = { redirectTo: string };
