import { ActionIcon, Badge, Group, Loader, Select, Stack, Text, Tooltip } from '@mantine/core';
import { IconPlus, IconX } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import type { CosmeticShopSectionMeta } from '~/server/schema/cosmetic-shop.schema';
import type { RouterOutput } from '~/types/router';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

/**
 * Which official shop sections a reviewed item is placed in, with add and remove. The homepage
 * shop blocks show a section, so placing an item here is how it reaches them.
 */
export function ShopSectionsPanel({
  shopItemId,
  placeable,
}: {
  shopItemId: number;
  /** Why it cannot be placed, when it cannot. The server refuses the same cases. */
  placeable: true | string;
}) {
  const queryUtils = trpc.useUtils();
  // Controlled so a pick clears the typed text: the select itself never holds a value.
  const [search, setSearch] = useState('');
  const placed = trpc.cosmeticShop.getShopItemSections.useQuery({ shopItemId });
  const sections = trpc.cosmeticShop.getAllSections.useQuery({});

  const onSuccess = async (data: RouterOutput['cosmeticShop']['getShopItemSections']) => {
    queryUtils.cosmeticShop.getShopItemSections.setData({ shopItemId }, data);
    await Promise.all([
      queryUtils.cosmeticShop.getAllSections.invalidate(),
      queryUtils.cosmeticShop.getSectionById.invalidate(),
    ]);
  };
  const onError = (error: { message: string }) =>
    showErrorNotification({ title: 'Failed to update sections', error: new Error(error.message) });
  const add = trpc.cosmeticShop.addShopItemToSection.useMutation({ onSuccess, onError });
  const remove = trpc.cosmeticShop.removeShopItemFromSection.useMutation({ onSuccess, onError });
  const busy = add.isPending || remove.isPending;

  const options = useMemo(() => {
    const placedIds = new Set((placed.data ?? []).map((s) => s.id));
    return (sections.data ?? [])
      .filter(
        // A community-hub section renders the creator feed, never its own items.
        (s) => !placedIds.has(s.id) && !(s.meta as CosmeticShopSectionMeta | null)?.communityHub
      )
      .map((s) => ({
        value: String(s.id),
        label: s.published ? s.title : `${s.title} (unpublished)`,
      }));
  }, [placed.data, sections.data]);

  return (
    <Stack gap={8}>
      <Text size="sm" fw={600}>
        Shop sections
      </Text>
      {placed.isLoading ? (
        <Loader size="xs" />
      ) : (
        <Group gap={6}>
          {placed.data?.length ? (
            placed.data.map((section) => (
              <Badge
                key={section.id}
                variant="light"
                radius="sm"
                color={section.published ? 'blue' : 'gray'}
                rightSection={
                  <Tooltip label="Remove from section" withinPortal>
                    <ActionIcon
                      size="xs"
                      variant="transparent"
                      color="gray"
                      aria-label={`Remove from ${section.title}`}
                      disabled={busy}
                      onClick={() => remove.mutate({ shopItemId, sectionId: section.id })}
                    >
                      <IconX size={12} />
                    </ActionIcon>
                  </Tooltip>
                }
              >
                {section.title}
              </Badge>
            ))
          ) : (
            <Text size="sm" c="dimmed">
              Not in any section.
            </Text>
          )}
        </Group>
      )}
      {placeable === true ? (
        <Select
          size="xs"
          w={260}
          placeholder="Add to section..."
          leftSection={<IconPlus size={14} />}
          data={options}
          value={null}
          searchable
          disabled={busy || sections.isLoading}
          nothingFoundMessage="No other sections"
          searchValue={search}
          onSearchChange={setSearch}
          onChange={(value) => {
            if (!value) return;
            setSearch('');
            add.mutate({ shopItemId, sectionId: Number(value) });
          }}
          comboboxProps={{ withinPortal: true }}
        />
      ) : (
        <Text size="xs" c="dimmed">
          {placeable}
        </Text>
      )}
    </Stack>
  );
}
