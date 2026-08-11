import { Slider } from '@mantine/core';
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
              { value: track.min, label: `${track.min}` },
              { value: cap, label: `cap ${cap}` },
              { value: track.max, label: `${track.max}` },
            ]
          : [
              { value: track.min, label: `${track.min}` },
              { value: track.max, label: `${track.max}` },
            ]
      }
      label={(current) => `${current} Buzz`}
      onChange={onChange}
      // Commits on release rather than per pixel: a drag emits a value per pixel
      // and each one would be a write. Not a debounce — a trailing timer can
      // land after the pointer is up and drop the value actually chosen.
      onChangeEnd={onCommit}
    />
  );
}
