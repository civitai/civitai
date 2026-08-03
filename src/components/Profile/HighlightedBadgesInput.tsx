import { Box, Group, Text, Tooltip } from '@mantine/core';
import { IconEyeOff } from '@tabler/icons-react';
import type { KeyboardEvent } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';

type BadgeItem = { id: number; name?: string | null; data?: { url?: string | null } | null };

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
  const toggle = (id: number) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  if (!badges.length)
    return (
      <Text size="xs" c="dimmed">
        You don&apos;t have any badges yet.
      </Text>
    );

  const accent = variant === 'hide' ? 'red' : 'yellow';

  return (
    <Group gap="xs">
      {badges.map((badge) => {
        const order = value.indexOf(badge.id);
        const selected = order >= 0;
        const url = badge.data?.url;
        return (
          <Tooltip key={badge.id} label={badge.name ?? 'Badge'} withArrow>
            <Box
              role="button"
              tabIndex={0}
              onClick={() => toggle(badge.id)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggle(badge.id);
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
