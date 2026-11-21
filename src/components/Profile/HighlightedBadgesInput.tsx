import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Box, Group, Stack, Text } from '@mantine/core';
import { Tooltip } from '~/components/MantineOverlays';
import { IconEyeOff } from '@tabler/icons-react';
import type { KeyboardEvent } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { getBadgeImageUrl, keepOwnedBadgeIds } from '~/shared/utils/badge-visibility';

type BadgeItem = { id: number; name?: string | null; data?: { url?: string | null } | null };

function groupBadgesByImage(badges: BadgeItem[]) {
  const groups = new Map<string, { badge: BadgeItem; ids: number[] }>();
  for (const badge of badges) {
    // Badges without an image have no tile to show.
    const key = getBadgeImageUrl({ data: badge.data });
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.ids.push(badge.id);
    else groups.set(key, { badge, ids: [badge.id] });
  }
  return [...groups.values()];
}

const TILE_SIZE = 56;

function BadgeImage({ badge }: { badge: BadgeItem }) {
  const url = badge.data?.url;
  if (!url) return null;
  return (
    <EdgeMedia
      src={url}
      width={64}
      alt={badge.name ?? 'Badge'}
      className="size-full object-contain"
      optimized
    />
  );
}

function PinNumber({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: 'absolute',
        top: -6,
        right: -6,
        width: 18,
        height: 18,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '50%',
        fontSize: 11,
        fontWeight: 700,
        color: 'var(--mantine-color-dark-9)',
        background: 'var(--mantine-color-yellow-5)',
      }}
    >
      {children}
    </div>
  );
}

// One pinned badge in the reorder strip. The id is the pinned cosmetic id.
function SortablePin({ id, badge, position }: { id: number; badge: BadgeItem; position: number }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    // A button here would collide with the toggle tiles below.
    attributes: { role: 'listitem' },
  });
  const name = badge.name ?? 'Badge';
  return (
    <Tooltip label={`${name}: drag to reorder`} withArrow>
      <Box
        ref={setNodeRef}
        aria-label={`Pin ${position}: ${name}`}
        {...attributes}
        {...listeners}
        style={{
          position: 'relative',
          width: TILE_SIZE,
          height: TILE_SIZE,
          padding: 4,
          borderRadius: 'var(--mantine-radius-md)',
          cursor: isDragging ? 'grabbing' : 'grab',
          border: '2px solid var(--mantine-color-yellow-5)',
          background: 'var(--mantine-color-yellow-light)',
          transform: CSS.Transform.toString(transform),
          transition,
          opacity: isDragging ? 0.6 : 1,
          zIndex: isDragging ? 1 : undefined,
          touchAction: 'manipulation',
        }}
      >
        <BadgeImage badge={badge} />
        <PinNumber>{position}</PinNumber>
      </Box>
    </Tooltip>
  );
}

// Owned badges as clickable tiles; clicking toggles a badge into the list.
// - highlight: click order is the display order; selected tiles show a ring +
//   the pin position. With two or more pins, a strip above the grid reorders
//   them by drag (or keyboard: space to lift, arrows to move, space to drop).
// - hide: selected tiles are dimmed with a red ring + eye-off marker (order is
//   irrelevant).
// Value is an array of cosmetic ids (ordered for highlight).
export function HighlightedBadgesInput({
  badges,
  value,
  onChange,
  variant = 'highlight',
  hiddenIds,
}: {
  badges: BadgeItem[];
  value: number[];
  onChange: (ids: number[]) => void;
  variant?: 'highlight' | 'hide';
  // highlight only: badges the user currently hides. Pinning one shows it again.
  hiddenIds?: number[];
}) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const tiles = groupBadgesByImage(badges);
  const toggle = (groupIds: number[]) =>
    onChange(
      groupIds.some((id) => value.includes(id))
        ? value.filter((x) => !groupIds.includes(x))
        : [...value, groupIds[0]]
    );

  if (!tiles.length)
    return (
      <Text size="xs" c="dimmed">
        You don&apos;t have any badges yet.
      </Text>
    );

  const accent = variant === 'hide' ? 'red' : 'yellow';
  // Number only the pins that have a tile, so a stale id can't leave a gap.
  const shownValue = keepOwnedBadgeIds(
    value,
    badges.map((b) => b.id)
  );

  // One entry per pinned tile, in pin order, keyed by the id that holds its slot in `value`.
  const pins =
    variant === 'highlight'
      ? tiles
          .map(({ badge, ids }) => {
            const slots = ids.map((id) => value.indexOf(id)).filter((index) => index >= 0);
            return slots.length ? { id: value[Math.min(...slots)], badge } : null;
          })
          .filter((pin) => pin !== null)
          .sort((a, b) => value.indexOf(a.id) - value.indexOf(b.id))
      : [];

  // Pins swap slots in `value`; unowned ids and any sibling ids stay where they are.
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const order = pins.map((pin) => pin.id);
    const from = order.indexOf(Number(active.id));
    const to = order.indexOf(Number(over.id));
    if (from < 0 || to < 0) return;
    const slots = order.map((id) => value.indexOf(id)).sort((a, b) => a - b);
    const next = [...value];
    arrayMove(order, from, to).forEach((id, i) => (next[slots[i]] = id));
    onChange(next);
  };

  return (
    <Stack gap="sm">
      {pins.length > 1 && (
        <div>
          <Text size="xs" c="dimmed" mb={4}>
            Drag to reorder your pins
          </Text>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={pins.map((pin) => pin.id)} strategy={rectSortingStrategy}>
              <Group gap="xs" role="list" aria-label="Pin order">
                {pins.map((pin, index) => (
                  <SortablePin key={pin.id} id={pin.id} badge={pin.badge} position={index + 1} />
                ))}
              </Group>
            </SortableContext>
          </DndContext>
        </div>
      )}
      <Group gap="xs">
        {tiles.map(({ badge, ids }) => {
          const order = Math.min(
            ...ids.map((id) => shownValue.indexOf(id)).filter((index) => index >= 0)
          );
          const selected = Number.isFinite(order);
          const hidden = variant === 'highlight' && !selected && !!hiddenIds?.includes(ids[0]);
          const name = badge.name ?? 'Badge';
          return (
            <Tooltip
              key={ids[0]}
              label={hidden ? `${name} (hidden: pinning shows it)` : name}
              withArrow
            >
              <Box
                role="button"
                aria-label={name}
                tabIndex={0}
                onClick={() => toggle(ids)}
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggle(ids);
                  }
                }}
                style={{
                  position: 'relative',
                  width: 56,
                  height: 56,
                  padding: 4,
                  borderRadius: 'var(--mantine-radius-md)',
                  cursor: 'pointer',
                  opacity: hidden ? 0.4 : selected ? (variant === 'hide' ? 0.45 : 1) : 0.65,
                  border: `2px solid ${
                    selected ? `var(--mantine-color-${accent}-5)` : 'transparent'
                  }`,
                  background: selected ? `var(--mantine-color-${accent}-light)` : undefined,
                }}
              >
                <BadgeImage badge={badge} />
                {selected &&
                  (variant === 'hide' ? (
                    <div
                      style={{
                        position: 'absolute',
                        top: -6,
                        right: -6,
                        width: 18,
                        height: 18,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderRadius: '50%',
                        color: 'white',
                        background: 'var(--mantine-color-red-5)',
                      }}
                    >
                      <IconEyeOff size={12} />
                    </div>
                  ) : (
                    <PinNumber>{pins.findIndex((pin) => pin.badge === badge) + 1}</PinNumber>
                  ))}
                {hidden && (
                  <IconEyeOff
                    size={14}
                    aria-hidden
                    style={{ position: 'absolute', bottom: 2, right: 2 }}
                  />
                )}
              </Box>
            </Tooltip>
          );
        })}
      </Group>
    </Stack>
  );
}
