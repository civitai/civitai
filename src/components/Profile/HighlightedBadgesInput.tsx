import { Box, Group, Text } from '@mantine/core';
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

// Owned badges as clickable tiles; clicking toggles a badge into the list.
// - highlight: click order is the display order; selected tiles show a ring +
//   the pin position.
// - hide: selected tiles are dimmed with a red ring + eye-off marker (order is
//   irrelevant).
// Value is an array of cosmetic ids (ordered for highlight).
export function HighlightedBadgesInput({
  badges,
  value,
  onChange,
  variant = 'highlight',
}: {
  badges: BadgeItem[];
  value: number[];
  onChange: (ids: number[]) => void;
  variant?: 'highlight' | 'hide';
}) {
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

  return (
    <Group gap="xs">
      {tiles.map(({ badge, ids }) => {
        const order = Math.min(
          ...ids.map((id) => shownValue.indexOf(id)).filter((index) => index >= 0)
        );
        const selected = Number.isFinite(order);
        const url = badge.data?.url;
        return (
          <Tooltip key={ids[0]} label={badge.name ?? 'Badge'} withArrow>
            <Box
              role="button"
              aria-label={badge.name ?? 'Badge'}
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
                opacity: selected ? (variant === 'hide' ? 0.45 : 1) : 0.65,
                border: `2px solid ${
                  selected ? `var(--mantine-color-${accent}-5)` : 'transparent'
                }`,
                background: selected ? `var(--mantine-color-${accent}-light)` : undefined,
              }}
            >
              {url && (
                <EdgeMedia
                  src={url}
                  width={64}
                  alt={badge.name ?? 'Badge'}
                  className="h-full w-full object-contain"
                  optimized
                />
              )}
              {selected && (
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
                    color: variant === 'hide' ? 'white' : 'var(--mantine-color-dark-9)',
                    background: `var(--mantine-color-${accent}-5)`,
                  }}
                >
                  {variant === 'hide' ? <IconEyeOff size={12} /> : order + 1}
                </div>
              )}
            </Box>
          </Tooltip>
        );
      })}
    </Group>
  );
}
