import {
  Button,
  Group,
  Modal,
  Paper,
  Skeleton,
  Stack,
  Switch,
  Text,
  Textarea,
  ThemeIcon,
} from '@mantine/core';
import { IconArrowsMoveVertical, IconStar } from '@tabler/icons-react';
import type { DragEndEvent, Modifier, UniqueIdentifier } from '@dnd-kit/core';
import { DndContext, PointerSensor, rectIntersection, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { forwardRef, type ComponentPropsWithoutRef } from 'react';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { CreatorShopFeaturePickerModal } from '~/components/CreatorShop/CreatorShopFeaturePickerModal';
import { CREATOR_SHOP_BORDER } from '~/components/CreatorShop/creator-shop.constants';
import { SortableItem } from '~/components/ImageUpload/SortableItem';
import {
  useMutateCreatorShop,
  useQueryCreatorShopSettings,
} from '~/components/CreatorShop/creator-shop.util';
import { useSeededState } from '~/components/CreatorShop/useSeededState';
import {
  CREATOR_SHOP_MAX_FEATURED,
  creatorShopSectionKeys,
  type CreatorShopSectionKey,
} from '~/server/schema/creator-shop.schema';

type SectionState = { key: CreatorShopSectionKey; visible: boolean };

// Lock dragging to the vertical axis (sections only reorder up/down).
const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

const sectionLabels: Record<CreatorShopSectionKey, string> = {
  featured: 'Featured',
  cosmetics: 'Cosmetics',
  resold: 'From other creators',
  merch: 'Merch (coming soon)',
  models: 'Models',
};

type SeedableSettings = {
  showModels?: boolean;
  sections?: { key: CreatorShopSectionKey; visible: boolean }[];
};

function seedSections(settings?: SeedableSettings | null): SectionState[] {
  const saved = settings?.sections;
  let ordered: SectionState[];
  if (saved?.length) {
    ordered = saved.map((s) => ({ key: s.key, visible: s.visible }));
    for (const key of creatorShopSectionKeys) {
      if (!ordered.some((s) => s.key === key)) ordered.push({ key, visible: true });
    }
  } else {
    ordered = creatorShopSectionKeys.map((key) => ({ key, visible: true }));
  }
  // Models visibility is mirrored by the legacy `showModels` flag.
  return ordered.map((s) =>
    s.key === 'models' ? { ...s, visible: settings?.showModels ?? s.visible } : s
  );
}

// forwardRef + prop spread so SortableItem's cloneElement can attach the drag
// ref/listeners onto the Paper (a plain function component would drop them).
const SectionRow = forwardRef<
  HTMLDivElement,
  { section: SectionState; onToggle: () => void } & ComponentPropsWithoutRef<'div'>
>(({ section, onToggle, ...dragProps }, ref) => {
  const label = sectionLabels[section.key];
  return (
    <Paper ref={ref} withBorder radius="md" p="sm" {...dragProps}>
      <Group justify="space-between" wrap="nowrap">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <IconArrowsMoveVertical
            size={18}
            className="shrink-0 cursor-grab text-gray-6 dark:text-dark-2"
          />
          <Text size="sm" fw={500} c={section.visible ? undefined : 'dimmed'} lineClamp={1}>
            {label}
          </Text>
        </Group>
        {/* Stop the drag sensor from swallowing the switch toggle. */}
        <Switch
          checked={section.visible}
          onChange={onToggle}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={`Show ${label} section`}
        />
      </Group>
    </Paper>
  );
});
SectionRow.displayName = 'SectionRow';

export function CreatorShopSettingsModal({ targetUserId }: { targetUserId?: number }) {
  const dialog = useDialogContext();
  const { settings, isLoading } = useQueryCreatorShopSettings(true, targetUserId);
  const { updateSettings } = useMutateCreatorShop();

  const [sections, setSections] = useSeededState(settings, seedSections);
  const [description, setDescription] = useSeededState(settings, (s) => s?.description ?? '');
  const [enabled, setEnabled] = useSeededState(settings, (s) => s?.enabled ?? false);
  const featuredCount = settings?.featuredItemIds?.length ?? 0;

  const toggleVisible = (key: CreatorShopSectionKey) =>
    setSections((prev) => prev.map((s) => (s.key === key ? { ...s, visible: !s.visible } : s)));

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setSections((prev) => {
      const ids = prev.map((s): UniqueIdentifier => s.key);
      return arrayMove(prev, ids.indexOf(active.id), ids.indexOf(over.id));
    });
  };

  const handleSave = async () => {
    const showModels = sections.find((s) => s.key === 'models')?.visible ?? false;
    await updateSettings.mutateAsync({
      userId: targetUserId,
      enabled,
      sections,
      showModels,
      description: description.trim() || null,
    });
    dialog.onClose();
  };

  const loading = isLoading && !settings;

  return (
    <Modal {...dialog} size="lg" title="Shop settings">
      <Stack gap="lg">
        <Stack gap={8}>
          <Text fw={600}>Visibility</Text>
          {loading ? (
            <Skeleton height={62} radius="md" />
          ) : (
            <Paper withBorder radius="md" p="md">
              <Group justify="space-between" wrap="nowrap" gap="sm">
                <Stack gap={0} style={{ minWidth: 0 }}>
                  <Text size="sm" fw={600}>
                    Shop is {enabled ? 'public' : 'private'}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {enabled
                      ? 'Visitors can find your shop on your profile.'
                      : 'Only you can see your shop while you get it ready.'}
                  </Text>
                </Stack>
                <Switch
                  checked={enabled}
                  onChange={(e) => setEnabled(e.currentTarget.checked)}
                  aria-label="Shop is public"
                />
              </Group>
            </Paper>
          )}
        </Stack>

        <Stack gap={8}>
          <Text fw={600}>Featured cosmetics</Text>
          {loading ? (
            <Skeleton height={62} radius="md" />
          ) : (
            <Paper withBorder radius="md" p="md">
              <Group justify="space-between" wrap="nowrap">
                <Group gap="sm" wrap="nowrap">
                  <ThemeIcon variant="light" color="yellow" radius="xl" size="lg">
                    <IconStar size={18} />
                  </ThemeIcon>
                  <Stack gap={0}>
                    <Text size="sm" fw={600}>
                      {featuredCount} of {CREATOR_SHOP_MAX_FEATURED} featured
                    </Text>
                    <Text size="xs" c="dimmed">
                      Highlighted at the top of your shop
                    </Text>
                  </Stack>
                </Group>
                <Button
                  variant="light"
                  color="yellow"
                  size="xs"
                  onClick={() =>
                    dialogStore.trigger({
                      component: CreatorShopFeaturePickerModal,
                      props: { targetUserId },
                    })
                  }
                >
                  Manage featured
                </Button>
              </Group>
            </Paper>
          )}
        </Stack>

        <Stack gap={8}>
          <div>
            <Text fw={600}>Sections</Text>
            <Text size="xs" c="dimmed">
              Toggle sections on or off, and drag to reorder them.
            </Text>
          </div>
          {loading ? (
            <Stack gap={8}>
              {creatorShopSectionKeys.map((key) => (
                <Skeleton key={key} height={58} radius="md" />
              ))}
            </Stack>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={rectIntersection}
              onDragEnd={handleDragEnd}
              modifiers={[restrictToVerticalAxis]}
            >
              <SortableContext
                items={sections.map((s) => s.key)}
                strategy={verticalListSortingStrategy}
              >
                <Stack gap={8}>
                  {sections.map((section) => (
                    <SortableItem key={section.key} id={section.key}>
                      <SectionRow section={section} onToggle={() => toggleVisible(section.key)} />
                    </SortableItem>
                  ))}
                </Stack>
              </SortableContext>
            </DndContext>
          )}
        </Stack>

        <Stack gap={8}>
          <Text fw={600}>Description</Text>
          {loading ? (
            <Skeleton height={72} radius="md" />
          ) : (
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.currentTarget.value)}
              autosize
              minRows={2}
              maxLength={300}
              placeholder="Tell shoppers about your shop (optional)"
              description={`${description.length}/300`}
              inputWrapperOrder={['label', 'input', 'description', 'error']}
            />
          )}
        </Stack>

        <Group justify="flex-end" pt="sm" style={{ borderTop: CREATOR_SHOP_BORDER }}>
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button loading={updateSettings.isPending} disabled={loading} onClick={handleSave}>
            Save changes
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
