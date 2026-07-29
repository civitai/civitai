import { Button, Paper, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconBuildingStore, IconPlus } from '@tabler/icons-react';
import Link from 'next/link';

export function EmptyShopState({
  isOwner,
  displayName,
  baseUrl,
}: {
  isOwner: boolean;
  displayName: string;
  baseUrl: string;
}) {
  return (
    <Paper withBorder radius="md" p="xl">
      <Stack align="center" gap="sm">
        <ThemeIcon size={56} radius="xl" variant="light" color="gray">
          <IconBuildingStore size={30} />
        </ThemeIcon>
        <Title order={4}>{isOwner ? 'Your shop is empty' : 'This shop is empty'}</Title>
        <Text size="sm" c="dimmed" ta="center" maw={440}>
          {isOwner
            ? 'List cosmetics for your fans to collect and buy with Buzz. Submit your first item to open your shop.'
            : `${displayName} hasn't listed anything yet.`}
        </Text>
        {isOwner && (
          <Button
            component={Link}
            href={`${baseUrl}/shop/manage`}
            leftSection={<IconPlus size={16} />}
          >
            Create your first item
          </Button>
        )}
      </Stack>
    </Paper>
  );
}
