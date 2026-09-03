import { Button, Group, Modal, Paper, Stack, Switch, Text } from '@mantine/core';
import type { DragEndEvent, DragOverEvent, Modifier, UniqueIdentifier } from '@dnd-kit/core';
import {
  DndContext,
  PointerSensor,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { IconArrowsMoveVertical, IconLock } from '@tabler/icons-react';
import type { ComponentPropsWithoutRef } from 'react';
import { forwardRef } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { SortableItem } from '~/components/ImageUpload/SortableItem';
import { navIcons } from '~/components/HomeContentToggle/nav-icons';
import { navRegistry } from '~/components/HomeContentToggle/nav-registry';
import type { NavGroup } from '~/components/HomeContentToggle/nav-registry';
import type { NavRow as Row } from '~/components/HomeContentToggle/nav-rows';
import { rowsToConfig, seedRows } from '~/components/HomeContentToggle/nav-rows';
import { useSeededState } from '~/components/CreatorShop/useSeededState';
import {
  useCurrentUserSettingsState,
  useMutateUserSettings,
} from '~/components/UserSettings/hooks';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { NavKey } from '~/shared/constants/nav.constants';
import { getDisplayName } from '~/utils/string-helpers';

// Rows only reorder up/down; the horizontal axis carries no meaning in either group.
const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

const GROUP_LABELS: Record<NavGroup, { title: string; hint: string }> = {
  bar: { title: 'Primary menu', hint: 'Shown as tabs, in this order.' },
  more: { title: 'More menu', hint: 'Collapsed into a dropdown at the end of the bar.' },
};

const NavRow = forwardRef<
  HTMLDivElement,
  { row: Row; onToggle?: () => void } & ComponentPropsWithoutRef<'div'>
>(({ row, onToggle, ...dragProps }, ref) => {
  const label = getDisplayName(row.key);
  return (
    <Paper ref={ref} withBorder radius="md" p="sm" {...dragProps}>
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
          {row.locked ? (
            <IconLock size={18} className="shrink-0 text-gray-6 dark:text-dark-2" />
          ) : (
            <IconArrowsMoveVertical
              size={18}
              className="shrink-0 cursor-grab text-gray-6 dark:text-dark-2"
            />
          )}
          {navIcons[row.key]({ size: 16 })}
          <Text
            size="sm"
            fw={500}
            c={row.hidden ? 'dimmed' : undefined}
            className="capitalize"
            lineClamp={1}
          >
            {label}
          </Text>
        </Group>
        {row.locked ? (
          <Text size="xs" c="dimmed">
            Always shown
          </Text>
        ) : (
          // Stop the drag sensor from swallowing the toggle.
          <Switch
            checked={!row.hidden}
            onChange={onToggle}
            onPointerDown={(e) => e.stopPropagation()}
            aria-label={`Show ${label}`}
          />
        )}
      </Group>
    </Paper>
  );
});
NavRow.displayName = 'NavRow';

function GroupColumn({
  group,
  rows,
  onToggle,
}: {
  group: NavGroup;
  rows: Row[];
  onToggle: (key: NavKey) => void;
}) {
  // A droppable wrapper so a group emptied of every item can still receive one.
  const { setNodeRef } = useDroppable({ id: group });
  const { title, hint } = GROUP_LABELS[group];

  return (
    <Stack gap={8}>
      <Stack gap={0}>
        <Text size="sm" fw={600}>
          {title}
        </Text>
        <Text size="xs" c="dimmed">
          {hint}
        </Text>
      </Stack>
      <SortableContext items={rows.map((row) => row.key)} strategy={verticalListSortingStrategy}>
        <Stack gap={8} ref={setNodeRef} mih={56}>
          {rows.map((row) =>
            row.locked ? (
              <NavRow key={row.key} row={row} />
            ) : (
              <SortableItem key={row.key} id={row.key}>
                <NavRow row={row} onToggle={() => onToggle(row.key)} />
              </SortableItem>
            )
          )}
          {rows.length === 0 && (
            <Text size="xs" c="dimmed" ta="center" py="sm">
              Drag an item here
            </Text>
          )}
        </Stack>
      </SortableContext>
    </Stack>
  );
}

export default function SubNavSettingsModal() {
  const dialog = useDialogContext();
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const { settings, isResolved } = useCurrentUserSettingsState();
  const mutate = useMutateUserSettings({ onSuccess: () => dialog.onClose() });

  // `undefined` until the query resolves, so `useSeededState` re-seeds when it lands rather than
  // treating a still-loading `{}` as the user's saved config and writing defaults over it.
  const source = isResolved ? settings ?? null : undefined;
  const [rows, setRows] = useSeededState(source, seedRows);
  const [showLabels, setShowLabels] = useSeededState(
    source,
    (s) => s?.navigation?.showLabels ?? true
  );

  // The same gate the nav applies, so the modal never offers a destination the viewer cannot
  // reach. Filtering only what is DISPLAYED — `rows` stays whole, so a gated item keeps its
  // place and is written back untouched instead of being dropped on save.
  const isReachable = (row: Row) =>
    navRegistry
      .find((entry) => entry.key === row.key)
      ?.visible?.({
        features,
        isAuthed: !!currentUser,
      }) ?? true;
  const shown = rows.filter(isReachable);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const groupOfDropTarget = (id: UniqueIdentifier, current: Row[]): NavGroup | undefined => {
    if (id === 'bar' || id === 'more') return id;
    return current.find((row) => row.key === id)?.group;
  };

  // Cross-group moves happen on DRAG OVER so the row follows the pointer into the other column;
  // reordering within a group settles on drag end.
  const handleDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) return;
    setRows((prev) => {
      const activeRow = prev.find((row) => row.key === active.id);
      const target = groupOfDropTarget(over.id, prev);
      if (!activeRow || activeRow.locked || !target || activeRow.group === target) return prev;
      return prev.map((row) => (row.key === active.id ? { ...row, group: target } : row));
    });
  };

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setRows((prev) => {
      const ids = prev.map((row): UniqueIdentifier => row.key);
      const from = ids.indexOf(active.id);
      const to = ids.indexOf(over.id);
      if (from === -1 || to === -1) return prev;
      return arrayMove(prev, from, to);
    });
  };

  const toggle = (key: NavKey) =>
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, hidden: !row.hidden } : row)));

  const handleSave = () => mutate.mutate({ navigation: rowsToConfig(rows, showLabels) });

  // Deletes the key rather than writing empty groups, so the user resumes tracking the defaults —
  // including nav items that ship later.
  const handleReset = () => mutate.mutate({ navigation: undefined });

  return (
    <Modal
      {...dialog}
      size="lg"
      title="Customize navigation"
      // Title and the action row stay put; only the list between them scrolls. The list grows
      // with the registry, so without this the buttons walk off the bottom of a short viewport.
      styles={{
        content: { maxHeight: 'calc(100dvh - 6rem)', display: 'flex', flexDirection: 'column' },
        body: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 },
      }}
    >
      <Stack gap="lg" className="min-h-0 flex-1">
        {/* `min-h-0` on both this and the parent: a flex child defaults to min-height:auto, which
            refuses to shrink below its content and hands the scrollbar to the page instead. */}
        <Stack gap="lg" className="min-h-0 flex-1 overflow-y-auto pr-1">
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

          <DndContext
            sensors={sensors}
            collisionDetection={rectIntersection}
            modifiers={[restrictToVerticalAxis]}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
          >
            <Stack gap="lg">
              {(['bar', 'more'] as const).map((group) => (
                <GroupColumn
                  key={group}
                  group={group}
                  rows={shown.filter((row) => row.group === group)}
                  onToggle={toggle}
                />
              ))}
            </Stack>
          </DndContext>
        </Stack>

        <Group justify="space-between" className="shrink-0">
          <Button
            variant="subtle"
            color="gray"
            onClick={handleReset}
            disabled={mutate.isPending || !isResolved}
          >
            Reset to default
          </Button>
          <Button onClick={handleSave} loading={mutate.isPending} disabled={!isResolved}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
