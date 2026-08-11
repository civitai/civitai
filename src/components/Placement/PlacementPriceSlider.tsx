import { Group, Slider, Text } from '@mantine/core';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { Currency } from '~/shared/utils/prisma/enums';
import { numberWithCommas } from '~/utils/number-helpers';
import {
  PLACEMENT_PRICE_STEP,
  placementPriceTrack,
  placementPriceUsable,
  type PlacementSurface,
} from '~/shared/utils/placement';

/**
 * The price a placer pays, for any surface that sells one.
 *
 * Shared rather than per-surface because a creator meets this control at three
 * levels — account, post, image — and two implementations meant two different
 * sets of reachable prices for one decision.
 *
 * The track runs from the surface's own floor to the creator's cap, so the
 * bounds move with their score and membership without this component knowing
 * anything about either.
 *
 * Deliberately renders no copy. Each site says something different about a
 * price it cannot show — inheriting, above the cap, off the grid — and folding
 * those in here would make the caption a switch over the caller's situation.
 */
/** A mark under the track: the bolt, then the number, grouped so it wraps as one. */
function PriceMark({ value, prefix }: { value: number; prefix?: string }) {
  return (
    <Group gap={2} wrap="nowrap" style={{ whiteSpace: 'nowrap' }}>
      {prefix && (
        <Text size="xs" c="dimmed" span>
          {prefix}
        </Text>
      )}
      <CurrencyIcon currency={Currency.BUZZ} size={12} />
      <Text size="xs" span>
        {numberWithCommas(value)}
      </Text>
    </Group>
  );
}

export function PlacementPriceSlider({
  surface,
  cap,
  value,
  fallback,
  onChange,
  onCommit,
  disabled,
  size,
}: {
  surface: PlacementSurface;
  /** `null` while the range is still loading. */
  cap: number | null;
  /** `''` means "no price of its own", which inherits rather than charging nothing. */
  value: number | '';
  /** Where the thumb rests when there is no price set. */
  fallback: number;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
  disabled?: boolean;
  size?: string;
}) {
  const track = placementPriceTrack(surface, cap);
  const clamp = (input: number) => Math.min(Math.max(input, track.min), track.max);

  return (
    <Slider
      size={size}
      // The marks sit under the track and the caller's caption sits under those.
      // Without this they land on top of each other.
      mb="lg"
      value={value === '' ? clamp(fallback) : clamp(value)}
      // A cap too narrow to offer a choice asks a question with one answer, and
      // until the range loads the ceiling is a guess a creator should not be
      // dragging against.
      disabled={disabled || cap == null || !placementPriceUsable(surface, cap)}
      min={track.min}
      max={track.max}
      step={PLACEMENT_PRICE_STEP}
      marks={
        cap != null && cap > track.min && cap < track.max
          ? [
              { value: track.min, label: <PriceMark value={track.min} /> },
              { value: cap, label: <PriceMark value={cap} prefix="cap " /> },
              { value: track.max, label: <PriceMark value={track.max} /> },
            ]
          : [
              { value: track.min, label: <PriceMark value={track.min} /> },
              { value: track.max, label: <PriceMark value={track.max} /> },
            ]
      }
      label={(current) => numberWithCommas(current)}
      onChange={onChange}
      // Commits on release rather than per pixel: a drag emits a value per pixel
      // and each one would be a write. Not a debounce — a trailing timer can
      // land after the pointer is up and drop the value actually chosen.
      onChangeEnd={onCommit}
    />
  );
}
