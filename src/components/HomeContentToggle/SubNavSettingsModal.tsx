import { Button, Group, Modal, Paper, SegmentedControl, Stack, Switch, Text } from '@mantine/core';
import type { DragEndEvent, Modifier, UniqueIdentifier } from '@dnd-kit/core';
import { DndContext, PointerSensor, rectIntersection, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { IconArrowsMoveVertical } from '@tabler/icons-react';
import type { ComponentPropsWithoutRef } from 'react';
import { forwardRef } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { SortableItem } from '~/components/ImageUpload/SortableItem';
import { navIcons } from '~/components/HomeContentToggle/nav-icons';
import { navRegistry } from '~/components/HomeContentToggle/nav-registry';
import type { NavPlacement } from '~/components/HomeContentToggle/nav-registry';
import { useSeededState } from '~/components/CreatorShop/useSeededState';
import { useCurrentUserSettings, useMutateUserSettings } from '~/components/UserSettings/hooks';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { NavigationSettingsSchema, UserContentSettings } from '~/server/schema/user.schema';
import type { NavKey } from '~/shared/constants/nav.constants';
import { getDisplayName } from '~/utils/string-helpers';

/**
 * One ordered list with a per-row zone picker, rather than three drop targets. Order within a
 * zone is the order of the rows carrying that zone, so a single drag axis expresses both "where
 * does this go" and "in what order" — and it stays operable by keyboard, which a cross-container
 * pointer drag does not.
 */
type Row = { key: NavKey; placement: NavPlacement };

// Sections only reorder up/down.
const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

const ZONE_OPTIONS = [
  { label: 'Bar', value: 'bar' },
  { label: 'More', value: 'more' },
  { label: 'Hidden', value: 'hidden' },
];

function seedRows(settings: UserContentSettings | null | undefined): Row[] {
  const config = settings?.navigation;
  const known = new Set(navRegistry.map((entry) => entry.key));
  const rows: Row[] = [];
  const seen = new Set<NavKey>();

  if (config) {
    for (const placement of ['bar', 'more', 'hidden'] as const) {
      for (const key of config[placement]) {
        if (!known.has(key) || seen.has(key)) continue;
        rows.push({ key, placement });
        seen.add(key);
      }
    }
  }
  // Anything the saved config never mentioned — including items added since they last saved.
  for (const entry of navRegistry) {
    if (!seen.has(entry.key)) rows.push({ key: entry.key, placement: entry.defaultPlacement });
  }
  return rows;
}

const NavRow = forwardRef<
  HTMLDivElement,
  { row: Row; onPlacement: (placement: NavPlacement) => void } & ComponentPropsWithoutRef<'div'>
>(({ row, onPlacement, ...dragProps }, ref) => {
  const label = getDisplayName(row.key);
  return (
    <Paper ref={ref} withBorder radius="md" p="sm" {...dragProps}>
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          <IconArrowsMoveVertical
            size={18}
            className="shrink-0 cursor-grab text-gray-6 dark:text-dark-2"
          />
          {navIcons[row.key]({ size: 16 })}
          <Text
            size="sm"
            fw={500}
            c={row.placement === 'hidden' ? 'dimmed' : undefined}
            className="capitalize"
            lineClamp={1}
          >
            {label}
          </Text>
        </Group>
        {/* Stop the drag sensor from swallowing the picker. */}
        <SegmentedControl
          size="xs"
          data={ZONE_OPTIONS}
          value={row.placement}
          onChange={(value) => onPlacement(value as NavPlacement)}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={`Where to show ${label}`}
        />
      </Group>
    </Paper>
  );
});
NavRow.displayName = 'NavRow';

export default function SubNavSettingsModal() {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const settings = useCurrentUserSettings();
  const mutate = useMutateUserSettings({ onSuccess: () => dialog.onClose() });

  const [rows, setRows] = useSeededState(settings, seedRows);
  const [showLabels, setShowLabels] = useSeededState(
    settings,
    (s) => s?.navigation?.showLabels ?? true
  );

  // Same gate the nav itself applies, so the modal never offers a destination the user cannot
  // reach — and never silently drops one either, since a hidden row would still be saved.
  const visibleRows = rows.filter((row) => {
    const entry = navRegistry.find((e) => e.key === row.key);
    return entry?.visible?.({ features, isAuthed: !!currentUser }) ?? true;
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setRows((prev) => {
      const ids = prev.map((r): UniqueIdentifier => r.key);
      return arrayMove(prev, ids.indexOf(active.id), ids.indexOf(over.id));
    });
  };

  const setPlacement = (key: NavKey, placement: NavPlacement) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, placement } : r)));

  const handleSave = () => {
    // Every zone, every time: the write replaces `navigation` outright rather than merging.
    const navigation: NavigationSettingsSchema = {
      bar: rows.filter((r) => r.placement === 'bar').map((r) => r.key),
      more: rows.filter((r) => r.placement === 'more').map((r) => r.key),
      hidden: rows.filter((r) => r.placement === 'hidden').map((r) => r.key),
      showLabels,
    };
    mutate.mutate({ navigation });
  };

  const handleReset = () => {
    // Deletes the key rather than writing empty zones, so the user goes back to tracking the
    // defaults — including nav items that ship later.
    mutate.mutate({ navigation: undefined });
  };

  return (
    <Modal {...dialog} size="lg" title="Customize navigation">
      <Stack gap="lg">
        <Paper withBorder radius="md" p="md">
          <Group justify="space-between" wrap="nowrap" gap="sm">
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text size="sm" fw={600}>
                Show labels
              </Text>
              <Text size="xs" c="dimmed">
                Turn off for an icon-only nav bar.
              </Text>
            </Stack>
            <Switch
              checked={showLabels}
              onChange={(e) => setShowLabels(e.currentTarget.checked)}
              aria-label="Show labels"
            />
          </Group>
        </Paper>

        <Stack gap={8}>
          <Text size="xs" c="dimmed">
            Drag to reorder. Items in More collapse into a dropdown at the end of the bar.
          </Text>
          <DndContext
            sensors={sensors}
            collisionDetection={rectIntersection}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={visibleRows.map((r) => r.key)}
              strategy={verticalListSortingStrategy}
            >
              <Stack gap={8}>
                {visibleRows.map((row) => (
                  <SortableItem key={row.key} id={row.key}>
                    <NavRow
                      row={row}
                      onPlacement={(placement) => setPlacement(row.key, placement)}
                    />
                  </SortableItem>
                ))}
              </Stack>
            </SortableContext>
          </DndContext>
        </Stack>

        <Group justify="space-between">
          <Button variant="subtle" color="gray" onClick={handleReset} disabled={mutate.isPending}>
            Reset to default
          </Button>
          <Button onClick={handleSave} loading={mutate.isPending}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
