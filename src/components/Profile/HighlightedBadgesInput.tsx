import { Box, Group, Text, Tooltip } from '@mantine/core';
import type { KeyboardEvent } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';

type BadgeItem = { id: number; name?: string | null; data?: { url?: string | null } | null };

// Owned badges as clickable tiles; clicking toggles a badge into the highlight
// list (the click order is the display order). Selected tiles show a ring + the
// pin position. Value is an ordered array of cosmetic ids.
export function HighlightedBadgesInput({
  badges,
  value,
  onChange,
}: {
  badges: BadgeItem[];
  value: number[];
  onChange: (ids: number[]) => void;
}) {
  const toggle = (id: number) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  if (!badges.length)
    return (
      <Text size="xs" c="dimmed">
        You don&apos;t have any badges yet.
      </Text>
    );

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
                opacity: selected ? 1 : 0.65,
                border: `2px solid ${selected ? 'var(--mantine-color-yellow-5)' : 'transparent'}`,
                background: selected ? 'var(--mantine-color-yellow-light)' : undefined,
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
                    color: 'var(--mantine-color-dark-9)',
                    background: 'var(--mantine-color-yellow-5)',
                  }}
                >
                  {order + 1}
                </div>
              )}
            </Box>
          </Tooltip>
        );
      })}
    </Group>
  );
}
