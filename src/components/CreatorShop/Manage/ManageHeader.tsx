import { ActionIcon, Button, Group, Stack, Text, Title, Tooltip } from '@mantine/core';
import { IconArrowLeft, IconPlus, IconSettings, IconShoppingBagPlus } from '@tabler/icons-react';
import Link from 'next/link';
import { CreatorShopSettingsModal } from '~/components/CreatorShop/CreatorShopSettingsModal';
import { CreatorShopSubmitModal } from '~/components/CreatorShop/CreatorShopSubmitModal';
import { ListExistingModal } from '~/components/CreatorShop/Manage/ListExistingModal';
import { dialogStore } from '~/components/Dialog/dialogStore';

export function ManageHeader({
  canAddItems = true,
  targetUserId,
  backHref,
}: {
  // Owners can add/resell items; a moderator managing someone else's shop cannot.
  canAddItems?: boolean;
  // Set when a moderator manages another creator's shop (threads into settings).
  targetUserId?: number;
  // Where the back arrow returns to (the storefront).
  backHref?: string;
}) {
  return (
    <Group justify="space-between" align="flex-end">
      <Group gap="sm" align="center" wrap="nowrap">
        {backHref && (
          <Tooltip label="Back to shop" withArrow>
            <ActionIcon
              component={Link}
              href={backHref}
              variant="default"
              size="lg"
              radius="xl"
              aria-label="Back to shop"
            >
              <IconArrowLeft size={18} />
            </ActionIcon>
          </Tooltip>
        )}
        <Stack gap={2}>
          <Title order={2}>{canAddItems ? 'Your Shop' : 'Manage Shop'}</Title>
          <Text size="sm" c="dimmed">
            Manage your listings and track sales
          </Text>
        </Stack>
      </Group>
      <Group gap="xs">
        <Button
          variant="default"
          leftSection={<IconSettings size={16} />}
          onClick={() =>
            dialogStore.trigger({ component: CreatorShopSettingsModal, props: { targetUserId } })
          }
        >
          Shop settings
        </Button>
        {canAddItems && (
          <>
            <Button
              variant="default"
              leftSection={<IconShoppingBagPlus size={16} />}
              onClick={() => dialogStore.trigger({ component: ListExistingModal })}
            >
              Resell a cosmetic
            </Button>
            <Button
              leftSection={<IconPlus size={16} />}
              onClick={() => dialogStore.trigger({ component: CreatorShopSubmitModal })}
            >
              Submit an item
            </Button>
          </>
        )}
      </Group>
    </Group>
  );
}
