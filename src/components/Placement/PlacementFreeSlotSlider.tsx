import { Group, Slider, Stack, Text } from '@mantine/core';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { effectiveFreeSlots, PLACEMENT_SURFACES } from '~/shared/utils/placement';
import type { PlacementSurface } from '~/shared/utils/placement';

/**
 * How many free placements a creator will accept on a space.
 *
 * Shared for the same reason `PlacementPriceSlider` is: a creator meets this
 * control on more than one surface and, once the per-image override lands, at
 * more than one level. Two implementations of one decision is two sets of
 * reachable answers, and the pasted pair this replaced had already diverged on
 * whether the displayed number was floored at zero.
 *
 * Renders its own label and caption, unlike the price slider, because there is
 * nothing surface-specific left to say once the noun is supplied — no
 * inheriting, no off-grid, no over-cap disclosure. The caller passes the words
 * for the thing being placed and nothing else.
 */
export function PlacementFreeSlotSlider({
  surface,
  cap,
  value,
  onChange,
  onCommit,
  /** Singular and plural of what is placed here: `['free sticker', 'free stickers']`. */
  noun,
}: {
  surface: PlacementSurface;
  /** The creator's ceiling. `0` hides the control — see below. */
  cap: number;
  /**
   * What the creator has chosen, or `null` for "never chosen", which follows the
   * surface default. The distinction is the whole mechanism: a stored number
   * stops tracking the default when it moves, so a control that cannot express
   * "unset" writes one on the first save and freezes it.
   */
  value: number | null;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
  noun: [singular: string, plural: string];
}) {
  const set = value ?? PLACEMENT_SURFACES[surface].defaultFreeSlots;
  // What the server will honour, through the shared helper rather than a local
  // `Math.min`. A stored count above the cap is carried rather than rewritten —
  // the same treatment a price gets — so the page has to state the smaller
  // number instead of the one on the row.
  const effective = effectiveFreeSlots(set, cap);

  return (
    <Stack gap={4}>
      <Group gap={4} wrap="nowrap">
        <Text size="sm" fw={500}>
          Free {noun[1]} you&apos;ll accept
        </Text>
        <InfoPopover size="xs" iconProps={{ size: 14 }} width={320}>
          <Text size="sm" maw={300} style={{ whiteSpace: 'normal' }}>
            People get one free placement a day across the whole site, and these are the slots they
            can spend it on. A slot is held while one waits for you, and comes back if you decline
            it or let it expire. Your maximum is {cap}, set by your creator score and membership
            tier. Paid placements never use these up.
          </Text>
        </InfoPopover>
      </Group>
      <Slider
        // The visible label is a sibling `Text`, so without this the thumb
        // reaches assistive tech — and any test driving it — as an unnamed
        // slider, indistinguishable from the price one beside it.
        thumbLabel={`Free ${noun[1]} you'll accept`}
        value={effective}
        onChange={onChange}
        onChangeEnd={onCommit}
        min={0}
        max={cap}
        step={1}
        label={null}
        marks={[
          { value: 0, label: 'None' },
          { value: cap, label: `${cap}` },
        ]}
      />
      {/* Clears the marks, which sit under the track. */}
      <Text size="sm" c="dimmed" mt={16}>
        <Text span fw={600} c="var(--mantine-color-text)">
          {effective}
        </Text>{' '}
        {effective === 1 ? noun[0] : noun[1]} per image
      </Text>
    </Stack>
  );
}
