import {
  Box,
  Button,
  Center,
  Group,
  Loader,
  Modal,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { IconCheck, IconPhotoOff, IconStar } from '@tabler/icons-react';
import type { ComponentProps } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import type { CreatorShopManageItem } from '~/components/CreatorShop/creator-shop.util';
import {
  useMutateCreatorShop,
  useQueryCreatorShopManage,
  useQueryCreatorShopSettings,
} from '~/components/CreatorShop/creator-shop.util';
import { useSeededState } from '~/components/CreatorShop/useSeededState';
import { CosmeticSample } from '~/components/Shop/CosmeticSample';
import { CREATOR_SHOP_MAX_FEATURED } from '~/server/schema/creator-shop.schema';
import { CosmeticShopItemStatus } from '~/shared/utils/prisma/enums';
import { getDisplayName } from '~/utils/string-helpers';

type SampleCosmetic = ComponentProps<typeof CosmeticSample>['cosmetic'];

const ART_THUMB_HEIGHT = 90;

function FeaturePickerCard({
  item,
  isSelected,
  disabled,
  onToggle,
}: {
  item: CreatorShopManageItem;
  isSelected: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <Paper
      withBorder
      radius="md"
      p={6}
      onClick={() => !disabled && onToggle()}
      style={{
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        transition: 'border-color 100ms ease, box-shadow 100ms ease',
        borderColor: isSelected ? 'var(--mantine-color-yellow-5)' : undefined,
        boxShadow: isSelected ? '0 0 0 1px var(--mantine-color-yellow-5)' : undefined,
      }}
    >
      <Box
        pos="relative"
        style={{
          height: ART_THUMB_HEIGHT,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--mantine-color-dark-8)',
          borderRadius: 'var(--mantine-radius-sm)',
          overflow: 'hidden',
        }}
      >
        <CosmeticSample cosmetic={item.cosmetic as unknown as SampleCosmetic} size="md" />
        {isSelected && (
          <ThemeIcon pos="absolute" top={6} right={6} radius="xl" size="sm" color="yellow">
            <IconCheck size={12} stroke={3} />
          </ThemeIcon>
        )}
      </Box>
      <Stack gap={0} mt={8} px={4} pb={2}>
        <Text size="sm" fw={600} lineClamp={1}>
          {item.title}
        </Text>
        <Text size="xs" c="dimmed" lineClamp={1}>
          {getDisplayName(item.cosmetic.type)}
        </Text>
      </Stack>
    </Paper>
  );
}

export function CreatorShopFeaturePickerModal({ targetUserId }: { targetUserId?: number }) {
  const dialog = useDialogContext();
  const { items, isLoading: itemsLoading } = useQueryCreatorShopManage(true, targetUserId);
  const { settings, isLoading: settingsLoading } = useQueryCreatorShopSettings(true, targetUserId);
  const { updateSettings } = useMutateCreatorShop();

  const [selected, setSelected] = useSeededState(settings, (s) => s?.featuredItemIds ?? []);

  const loading = itemsLoading || settingsLoading;
  const publishedItems = items.filter((i) => i.status === CosmeticShopItemStatus.Published);
  const atCap = selected.length >= CREATOR_SHOP_MAX_FEATURED;

  const toggle = (id: number) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : atCap ? prev : [...prev, id]
    );

  const handleSave = async () => {
    await updateSettings.mutateAsync({ userId: targetUserId, featuredItemIds: selected });
    dialog.onClose();
  };

  return (
    <Modal {...dialog} size="lg" title="Feature cosmetics">
      <Stack>
        <Text size="sm" c="dimmed">
          Choose up to {CREATOR_SHOP_MAX_FEATURED} cosmetics to highlight at the top of your shop.
          Only published items can be featured.
        </Text>

        {loading ? (
          <Center py="xl">
            <Loader />
          </Center>
        ) : publishedItems.length === 0 ? (
          <Paper withBorder radius="md" p="xl">
            <Stack align="center" gap={6}>
              <ThemeIcon variant="light" color="gray" radius="xl" size={44}>
                <IconPhotoOff size={22} />
              </ThemeIcon>
              <Text size="sm" fw={600}>
                No published cosmetics to feature yet
              </Text>
              <Text size="xs" c="dimmed" ta="center">
                Once an item is approved and published, it&apos;ll show up here.
              </Text>
            </Stack>
          </Paper>
        ) : (
          <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
            {publishedItems.map((item) => {
              const isSelected = selected.includes(item.id);
              return (
                <FeaturePickerCard
                  key={item.id}
                  item={item}
                  isSelected={isSelected}
                  disabled={!isSelected && atCap}
                  onToggle={() => toggle(item.id)}
                />
              );
            })}
          </SimpleGrid>
        )}

        <Stack gap={6}>
          <Group justify="space-between" align="center">
            <Group gap={6} align="center">
              <IconStar size={16} color="var(--mantine-color-yellow-5)" />
              <Text size="sm" fw={500}>
                {selected.length} of {CREATOR_SHOP_MAX_FEATURED} selected
              </Text>
            </Group>
            {atCap && (
              <Text size="xs" c="dimmed">
                Maximum reached
              </Text>
            )}
          </Group>
          <Progress
            value={(selected.length / CREATOR_SHOP_MAX_FEATURED) * 100}
            color="yellow"
            size="xs"
            radius="xl"
          />
        </Stack>

        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button loading={updateSettings.isPending} disabled={loading} onClick={handleSave}>
            Save featured
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
