import { Button, Paper, Stack, Text } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { CreatorShopSubmitModal } from '~/components/CreatorShop/CreatorShopSubmitModal';
import { dialogStore } from '~/components/Dialog/dialogStore';

export function ManageEmptyState({ hasItems }: { hasItems: boolean }) {
  return (
    <Paper withBorder radius="md" p="xl">
      <Stack gap={4} align="center" py="md">
        <Text fw={600}>{hasItems ? 'Nothing here' : 'No items yet'}</Text>
        <Text size="sm" c="dimmed" ta="center">
          {hasItems
            ? 'No items match this filter.'
            : 'Submit your first item to start selling in your shop.'}
        </Text>
        {!hasItems && (
          <Button
            mt="xs"
            variant="light"
            leftSection={<IconPlus size={16} />}
            onClick={() => dialogStore.trigger({ component: CreatorShopSubmitModal })}
          >
            Submit a new item
          </Button>
        )}
      </Stack>
    </Paper>
  );
}
