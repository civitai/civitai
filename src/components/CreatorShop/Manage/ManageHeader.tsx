import { Button, Group, Stack, Text, Title } from '@mantine/core';
import { IconPlus, IconSettings } from '@tabler/icons-react';
import { CreatorShopSettingsModal } from '~/components/CreatorShop/CreatorShopSettingsModal';
import { CreatorShopSubmitModal } from '~/components/CreatorShop/CreatorShopSubmitModal';
import { dialogStore } from '~/components/Dialog/dialogStore';

export function ManageHeader() {
  return (
    <Group justify="space-between" align="flex-end">
      <Stack gap={2}>
        <Title order={2}>Your Shop</Title>
        <Text size="sm" c="dimmed">
          Manage your listings and track sales
        </Text>
      </Stack>
      <Group gap="xs">
        <Button
          variant="default"
          leftSection={<IconSettings size={16} />}
          onClick={() => dialogStore.trigger({ component: CreatorShopSettingsModal })}
        >
          Shop settings
        </Button>
        <Button
          leftSection={<IconPlus size={16} />}
          onClick={() => dialogStore.trigger({ component: CreatorShopSubmitModal })}
        >
          Submit an item
        </Button>
      </Group>
    </Group>
  );
}
