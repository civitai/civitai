import { Button, Paper, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconArrowRight, IconBuildingStore } from '@tabler/icons-react';
import Link from 'next/link';

// Shown on the manage page when the owner isn't a Creator Program member.
export function ManageUpsell() {
  return (
    <Stack gap="lg" mt="md" pb="xl">
      <Paper withBorder radius="md" p="xl">
        <Stack align="center" gap="sm">
          <ThemeIcon size={56} radius="xl" variant="light" color="yellow">
            <IconBuildingStore size={30} />
          </ThemeIcon>
          <Text fw={700} size="lg" ta="center">
            The Creator Shop is a Creator Program benefit
          </Text>
          <Text size="sm" c="dimmed" ta="center" maw={460}>
            Join the Creator Program to open your shop and sell your own cosmetics for Buzz.
          </Text>
          <Button
            component={Link}
            href="/creator-program"
            rightSection={<IconArrowRight size={16} />}
            mt="xs"
          >
            Learn about the Creator Program
          </Button>
        </Stack>
      </Paper>
    </Stack>
  );
}
