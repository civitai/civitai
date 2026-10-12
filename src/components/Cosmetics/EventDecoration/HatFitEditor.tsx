import { Button, Group, Paper, Slider, Stack, Text, UnstyledButton } from '@mantine/core';
import clsx from 'clsx';
import type { CSSProperties } from 'react';
import { useState } from 'react';
import type { HatFitChanges } from '~/components/Cosmetics/EventDecoration/event-decoration-placement';
import {
  applyHatFitChanges,
  HAT_LOOK,
} from '~/components/Cosmetics/EventDecoration/event-decoration-placement';
import { ITEM_BLEED } from '~/components/MasonryColumns/masonry.constants';
import { TwCosmeticWrapper } from '~/components/TwCosmeticWrapper/TwCosmeticWrapper';
import type { EventDecorationData } from '~/shared/constants/event-decoration.constants';
import { HAT_FIT_LIMITS } from '~/shared/constants/event-decoration.constants';

type Scalar = 'size' | 'tilt' | 'depth' | 'grow';

const SCALARS: {
  key: Scalar;
  label: string;
  step: number;
  look: number;
  show: (x: number) => string;
}[] = [
  { key: 'size', label: 'Size', step: 1, look: HAT_LOOK.brim, show: (x) => `${x}px brim` },
  { key: 'tilt', label: 'Tilt', step: 1, look: HAT_LOOK.tilt, show: (x) => `${x}°` },
  {
    key: 'depth',
    label: 'Depth on the card',
    step: 0.01,
    look: HAT_LOOK.onCard,
    show: (x) => `${Math.round(x * 100)}% of its height`,
  },
  { key: 'grow', label: 'Hover growth', step: 0.05, look: HAT_LOOK.grow, show: (x) => `${x}×` },
];

/**
 * Edits one event hat's placement, previewed on real cards: plain, framed, and in a container
 * with no room. Hover a card to see the hat grow.
 */
export function HatFitEditor({
  hat,
  saving,
  onSave,
}: {
  hat: EventDecorationData;
  saving?: boolean;
  onSave: (changes: HatFitChanges) => unknown;
}) {
  const [changes, setChanges] = useState<HatFitChanges>({});
  const fit = applyHatFitChanges(hat.fit, changes);
  const preview = { ...hat, fit };
  const dirty = Object.keys(changes).length > 0;
  const offset = fit.offset ?? [0, 0];

  const change = (next: HatFitChanges) => setChanges((current) => ({ ...current, ...next }));

  return (
    <Stack gap="lg">
      <Group align="flex-start" gap="xl" wrap="wrap">
        <Sample label="Plain card" hat={preview} />
        <Sample label="Framed card" hat={preview} framed />
        <Sample label="No room (carousel)" hat={preview} tight />
      </Group>

      <Stack gap="md" maw={480}>
        {SCALARS.map(({ key, label, step, look, show }) => {
          const value = fit[key] ?? look;
          return (
            <Setting
              key={key}
              label={label}
              shown={show(value)}
              isLook={fit[key] === undefined}
              onReset={() => change({ [key]: null })}
            >
              <Slider
                min={HAT_FIT_LIMITS[key][0]}
                max={HAT_FIT_LIMITS[key][1]}
                step={step}
                value={value}
                label={null}
                onChange={(x) => change({ [key]: x })}
                aria-label={label}
              />
            </Setting>
          );
        })}
        {(['Move right', 'Move down'] as const).map((label, axis) => (
          <Setting
            key={label}
            label={label}
            shown={`${offset[axis]}px${offset[axis] < 0 ? (axis ? ' (up)' : ' (left)') : ''}`}
            isLook={fit.offset === undefined}
            onReset={() => change({ offset: null })}
          >
            <Slider
              min={HAT_FIT_LIMITS.offset[0]}
              max={HAT_FIT_LIMITS.offset[1]}
              step={1}
              value={offset[axis]}
              label={null}
              onChange={(x) => change({ offset: axis === 0 ? [x, offset[1]] : [offset[0], x] })}
              aria-label={label}
            />
          </Setting>
        ))}
      </Stack>

      <Group>
        <Button onClick={() => onSave(changes)} disabled={!dirty} loading={saving}>
          Save for everyone wearing it
        </Button>
        <Button variant="default" onClick={() => setChanges({})} disabled={!dirty || saving}>
          Discard changes
        </Button>
      </Group>
    </Stack>
  );
}

function Setting({
  label,
  shown,
  isLook,
  onReset,
  children,
}: {
  label: string;
  shown: string;
  isLook: boolean;
  onReset: () => void;
  children: React.ReactNode;
}) {
  return (
    <Stack gap={4}>
      <Group justify="space-between">
        <Text size="sm" fw={500}>
          {label}{' '}
          <Text span size="sm" c="dimmed">
            {shown}
            {isLook && ' (default)'}
          </Text>
        </Text>
        {!isLook && (
          <UnstyledButton onClick={onReset}>
            <Text size="xs" c="blue">
              Use default
            </Text>
          </UnstyledButton>
        )}
      </Group>
      {children}
    </Stack>
  );
}

// The dashed line is where a feed crops what a card paints outside itself.
function Sample({
  label,
  hat,
  framed,
  tight,
}: {
  label: string;
  hat: EventDecorationData;
  framed?: boolean;
  tight?: boolean;
}) {
  const room = tight ? 0 : ITEM_BLEED;
  return (
    <Stack gap={6} align="flex-start">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Paper
        withBorder={false}
        className={clsx(
          'border border-dashed border-gray-5',
          tight && '[--event-decoration-grow:1]'
        )}
        style={{ padding: room, '--event-decoration-allowance': `${room}px` } as CSSProperties}
      >
        {/* A frame lays its card out to fill the frame, as the feed sizes both. */}
        <TwCosmeticWrapper
          cosmetic={framed ? { cssFrame: 'linear-gradient(135deg, #fab005, #be4bdb)' } : undefined}
          eventDecoration={hat}
          style={{ width: 160, height: 200 }}
        >
          <div className="h-full w-full rounded-lg bg-gradient-to-br from-gray-6 to-gray-8" />
        </TwCosmeticWrapper>
      </Paper>
    </Stack>
  );
}
