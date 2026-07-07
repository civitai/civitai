import { Button, Group, Stack, Text, Title } from '@mantine/core';
import { IconPlus, IconSettings, IconShoppingBag } from '@tabler/icons-react';
import Link from 'next/link';

export function ShopHeader({
  displayName,
  description,
  isOwner,
  baseUrl,
}: {
  displayName: string;
  description?: string | null;
  isOwner: boolean;
  baseUrl: string;
}) {
  const trimmed = description?.trim();

  return (
    <Group justify="space-between" align="flex-end">
      <Stack gap={2}>
        <Group gap={8} align="center">
          <IconShoppingBag size={22} />
          <Title order={2}>{displayName}&apos;s Shop</Title>
        </Group>
        {trimmed ? (
          <Text size="sm" mt={4} className="max-w-2xl">
            {trimmed}
          </Text>
        ) : isOwner ? (
          <Text size="xs" c="dimmed" fs="italic" mt={4}>
            Add a shop description in Shop settings.
          </Text>
        ) : null}
      </Stack>
      {isOwner && (
        <Group gap="xs">
          <Button
            component={Link}
            href={`${baseUrl}/shop/manage`}
            variant="default"
            leftSection={<IconSettings size={16} />}
          >
            Manage Your Shop
          </Button>
        </Group>
      )}
    </Group>
  );
}
