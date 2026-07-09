import { Button, Group, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { IconSettings, IconShoppingBag } from '@tabler/icons-react';
import Link from 'next/link';

export function ShopHeader({
  displayName,
  description,
  isOwner,
  canManage,
  baseUrl,
}: {
  displayName: string;
  description?: string | null;
  isOwner: boolean;
  // Owners and moderators can manage the shop.
  canManage: boolean;
  baseUrl: string;
}) {
  const trimmed = description?.trim();

  return (
    <Group justify="space-between" align="flex-start" wrap="nowrap">
      <Group gap="md" align="center" wrap="nowrap" style={{ minWidth: 0 }}>
        <ThemeIcon size={48} radius="xl" variant="light" color="yellow">
          <IconShoppingBag size={28} />
        </ThemeIcon>
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Title order={1} size="h2">
            {displayName}&apos;s Shop
          </Title>
          {trimmed ? (
            <Text size="sm" c="dimmed" lineClamp={2} className="max-w-2xl">
              {trimmed}
            </Text>
          ) : isOwner ? (
            <Text size="xs" c="dimmed" fs="italic">
              Add a shop description in Shop settings.
            </Text>
          ) : null}
        </Stack>
      </Group>
      {canManage && (
        <Button
          component={Link}
          href={`${baseUrl}/shop/manage`}
          variant="default"
          leftSection={<IconSettings size={16} />}
          style={{ flexShrink: 0 }}
        >
          {isOwner ? 'Manage Your Shop' : 'Manage Shop'}
        </Button>
      )}
    </Group>
  );
}
