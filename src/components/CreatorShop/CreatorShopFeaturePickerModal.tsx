import {
  Badge,
  Button,
  Card,
  Center,
  Group,
  Loader,
  Modal,
  SimpleGrid,
  Stack,
  Text,
  ThemeIcon,
} from '@mantine/core';
import { IconCheck, IconStar } from '@tabler/icons-react';
import type { ComponentProps } from 'react';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import {
  useMutateCreatorShop,
  useQueryCreatorShopManage,
  useQueryCreatorShopSettings,
} from '~/components/CreatorShop/creator-shop.util';
import { CosmeticSample } from '~/components/Shop/CosmeticSample';
import { CREATOR_SHOP_MAX_FEATURED } from '~/server/schema/creator-shop.schema';
import { CosmeticShopItemStatus } from '~/shared/utils/prisma/enums';
import { getDisplayName } from '~/utils/string-helpers';

type SampleCosmetic = ComponentProps<typeof CosmeticSample>['cosmetic'];

export function CreatorShopFeaturePickerModal() {
  const dialog = useDialogContext();
  const { items, isLoading } = useQueryCreatorShopManage();
  const { settings } = useQueryCreatorShopSettings();
  const { updateSettings } = useMutateCreatorShop();

  const [selected, setSelected] = useState<number[]>(settings?.featuredItemIds ?? []);
  const publishedItems = items.filter((i) => i.status === CosmeticShopItemStatus.Published);
  const atCap = selected.length >= CREATOR_SHOP_MAX_FEATURED;

  const toggle = (id: number) =>
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : atCap ? prev : [...prev, id]
    );

  const handleSave = async () => {
    await updateSettings.mutateAsync({ featuredItemIds: selected });
    dialog.onClose();
  };

  return (
    <Modal {...dialog} size="lg" title="Feature cosmetics">
      <Stack>
        <Text size="sm" c="dimmed">
          Choose cosmetics to highlight at the top of your shop. Only published items can be
          featured.
        </Text>

        {isLoading ? (
          <Center py="xl">
            <Loader />
          </Center>
        ) : publishedItems.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center" py="lg">
            You have no published cosmetics to feature yet.
          </Text>
        ) : (
          <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
            {publishedItems.map((item) => {
              const isSelected = selected.includes(item.id);
              const disabled = !isSelected && atCap;
              return (
                <Card
                  key={item.id}
                  withBorder
                  padding={6}
                  radius="md"
                  onClick={() => !disabled && toggle(item.id)}
                  style={{
                    cursor: disabled ? 'not-allowed' : 'pointer',
                    opacity: disabled ? 0.5 : 1,
                    borderColor: isSelected ? 'var(--mantine-color-blue-6)' : undefined,
                    borderWidth: isSelected ? 2 : 1,
                  }}
                >
                  <Card.Section
                    pos="relative"
                    style={{
                      height: 90,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      background: 'var(--mantine-color-dark-8)',
                    }}
                  >
                    <CosmeticSample
                      cosmetic={item.cosmetic as unknown as SampleCosmetic}
                      size="md"
                    />
                    {isSelected && (
                      <ThemeIcon
                        pos="absolute"
                        top={6}
                        right={6}
                        radius="xl"
                        size="sm"
                        color="blue"
                      >
                        <IconCheck size={12} />
                      </ThemeIcon>
                    )}
                  </Card.Section>
                  <Stack gap={2} mt={6}>
                    <Text size="xs" fw={600} lineClamp={1}>
                      {item.title}
                    </Text>
                    <Badge size="xs" variant="light" color="gray">
                      {getDisplayName(item.cosmetic.type)}
                    </Badge>
                  </Stack>
                </Card>
              );
            })}
          </SimpleGrid>
        )}

        <Group justify="space-between">
          <Group gap={6} align="center">
            <IconStar size={16} color="var(--mantine-color-yellow-5)" />
            <Text size="sm">
              {selected.length} of {CREATOR_SHOP_MAX_FEATURED} selected
            </Text>
          </Group>
          <Group gap="xs">
            <Button variant="default" onClick={dialog.onClose}>
              Cancel
            </Button>
            <Button loading={updateSettings.isPending} onClick={handleSave}>
              Save featured
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
