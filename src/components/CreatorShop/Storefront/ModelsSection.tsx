import { Badge, Button, Group, Stack, Text, Title } from '@mantine/core';
import { IconArrowRight } from '@tabler/icons-react';
import Link from 'next/link';
import type { CreatorShopData } from '~/components/CreatorShop/creator-shop.util';
import { SectionAccent } from '~/components/CreatorShop/Storefront/SectionAccent';

export function ModelsSection({
  shop,
  modelCount,
  displayName,
  baseUrl,
}: {
  shop: CreatorShopData;
  modelCount: number;
  displayName: string;
  baseUrl: string;
}) {
  if (!shop.settings.showModels || modelCount <= 0) return null;

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <div>
          <Group gap={10} align="center">
            <SectionAccent />
            <Title order={4}>Models</Title>
            <Badge variant="light" color="gray" radius="sm">
              {modelCount}
            </Badge>
          </Group>
          <Text size="xs" c="dimmed">
            Early Access &amp; Paid models by {displayName}
          </Text>
        </div>
        <Button
          component={Link}
          href={`${baseUrl}/models`}
          variant="light"
          rightSection={<IconArrowRight size={16} />}
        >
          Browse {displayName}&apos;s {modelCount} models
        </Button>
      </Group>
    </Stack>
  );
}
