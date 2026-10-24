import {
  Badge,
  Button,
  Group,
  Input,
  Modal,
  NumberInput,
  Paper,
  Slider,
  Stack,
  Text,
} from '@mantine/core';
import { IconArrowsLeftRight, IconBookmark, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { dialogStore, useDialogStore } from '~/components/Dialog/dialogStore';
import { useSizePresets } from '~/components/generation_v2/inputs/useSizePresets';
import {
  MEGAPIXEL,
  fitCustomDimensions,
  type CustomDimensionLimits,
} from '~/utils/aspect-ratio-helpers';

type Dimensions = { width: number; height: number };

/**
 * The range one side can take, given the other. The limits are joint — area and
 * ratio tie the sides together — so a fixed 512–2048 range per slider let a side be
 * set to a value the other side then forbade (1440 wide at 512 tall is past
 * 2.5:1, and snapped back to 1280). Each slider's ends move with the other side
 * instead, so every position on it is a size that will be accepted.
 */
export function sideRange(other: number, limits: CustomDimensionLimits) {
  const { step, minSide, maxSide, maxArea, maxRatio } = limits;
  const ceilStep = (n: number) => Math.ceil(n / step) * step;
  const floorStep = (n: number) => Math.floor(n / step) * step;
  // The longest a side can ever be: past it, the shortest partner the ratio allows
  // already breaks the area cap. Every current group reaches maxSide; a tighter cap
  // (1.5 MP at 2.5:1, say) would stop it at 1952.
  let longest = floorStep(maxSide);
  while (longest > minSide && longest * Math.max(minSide, ceilStep(longest / maxRatio)) > maxArea)
    longest -= step;

  const otherSide = Math.min(longest, Math.max(minSide, other));
  const byRatio = floorStep(otherSide * maxRatio);
  const byArea = floorStep(maxArea / otherSide);
  const max = Math.min(longest, byRatio, byArea);
  const min = Math.max(minSide, ceilStep(otherSide / maxRatio));
  // Ties go to the side: at height 2048 the area cap may also land on 2048, but
  // "lower the height to go further" would be false advice there.
  const limitedBy = max === floorStep(maxSide) ? 'side' : max === byRatio ? 'ratio' : 'area';
  return { min, max: Math.max(min, max), limitedBy, longest } as const;
}

/** In MEGAPIXEL (1024²) units, so the ~1024² buckets read 1.00 and 2048² reads 4.00. */
const megapixelsOf = (area: number) => (area / MEGAPIXEL).toFixed(2);

/**
 * Shapes the modal offers in one click, landscape-first. Each keeps the current
 * pixel count and changes only the shape — what Forge's aspect-ratio buttons do
 * with their lock on — and follows the current orientation, so a portrait size
 * gets 9:16 from "16:9". Swap turns any of them the other way.
 */
const QUICK_RATIOS = [
  [1, 1],
  [4, 3],
  [3, 2],
  [16, 9],
  [21, 9],
] as const;

/** `size` reshaped to `ratio` (width ÷ height) at the same area, then fitted. */
function atRatio(size: Dimensions, ratio: number, limits: CustomDimensionLimits) {
  const area = size.width * size.height;
  return fitCustomDimensions(
    { width: Math.sqrt(area * ratio), height: Math.sqrt(area / ratio) },
    limits
  );
}

function limitNote(
  side: 'width' | 'height',
  range: ReturnType<typeof sideRange>,
  limits: CustomDimensionLimits
) {
  const other = side === 'width' ? 'height' : 'width';
  if (range.limitedBy === 'ratio')
    return `Up to ${range.max} at this ${other} (${limits.maxRatio}:1 at most) — raise the ${other} to go further.`;
  if (range.limitedBy === 'area')
    return `Up to ${range.max} at this ${other} (${megapixelsOf(
      limits.maxArea
    )} MP at most) — lower the ${other} to go further.`;
  return undefined;
}

/** Mantine's md slider: an 8px track inside a 16px-tall root padded 8px each side. */
const TRACK = 8;

/**
 * A side's slider over the FULL range a side can ever take, with the part the
 * other side currently rules out greyed — so moving the height visibly grows or
 * shrinks what the width can reach, instead of the slider's ends silently moving.
 * Dragging into a greyed zone stops at its edge. The number box beside it takes
 * the same allowed range.
 */
function SideSlider({
  label,
  value,
  onChange,
  full,
  allowed,
  step,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  full: { min: number; max: number };
  allowed: { min: number; max: number };
  step: number;
}) {
  const clamp = (v: number) => Math.min(allowed.max, Math.max(allowed.min, v));
  const pct = (v: number) => ((v - full.min) / (full.max - full.min)) * 100;
  const blocked = [
    allowed.min > full.min && { left: 0, right: pct(allowed.min), atStart: true },
    allowed.max < full.max && { left: pct(allowed.max), right: 100, atEnd: true },
  ].filter(Boolean) as { left: number; right: number; atStart?: boolean; atEnd?: boolean }[];

  return (
    <Input.Wrapper label={label} styles={{ label: { marginBottom: 0 } }}>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Slider
            min={full.min}
            max={full.max}
            step={step}
            value={value}
            onChange={(v) => onChange(clamp(v))}
            label={null}
            thumbLabel={label}
          />
          {/* Over the track, under the thumb (Mantine's thumb is z-index 3). */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 flex items-center"
            style={{ left: TRACK, right: TRACK }}
          >
            {blocked.map((zone) => (
              <div
                key={zone.atStart ? 'start' : 'end'}
                data-blocked-zone={`${label.toLowerCase()}-${zone.atStart ? 'start' : 'end'}`}
                className="absolute"
                style={{
                  // The track's own background reaches TRACK px past each end.
                  left: zone.atStart ? -TRACK : `${zone.left}%`,
                  right: zone.atEnd ? -TRACK : `${100 - zone.right}%`,
                  height: TRACK,
                  zIndex: 2,
                  borderRadius: TRACK,
                  background:
                    'repeating-linear-gradient(-45deg, var(--mantine-color-default-border) 0 3px, var(--mantine-color-body) 3px 6px)',
                }}
              />
            ))}
          </div>
        </div>
        <NumberInput
          aria-label={label}
          value={value}
          min={allowed.min}
          max={allowed.max}
          step={step}
          allowDecimal={false}
          allowNegative={false}
          onChange={(v) => typeof v === 'number' && onChange(v)}
          // Blur only clamps to min/max; snap too, so "1000" reads 992 — what Apply sends.
          onBlur={() => onChange(clamp(Math.round(value / step) * step))}
          className="w-[84px] shrink-0"
        />
      </div>
    </Input.Wrapper>
  );
}

function CustomDimensionsModal({
  initial,
  limits,
  onResolve,
}: {
  initial: Dimensions;
  limits: CustomDimensionLimits;
  onResolve: (dimensions: Dimensions | null) => void;
}) {
  const dialog = useDialogContext();
  const [size, setSize] = useState<Dimensions>(
    () => fitCustomDimensions(initial, limits) ?? { width: 1024, height: 1024 }
  );
  // Every slider spans everything a side could ever be, whatever the other side is;
  // what is out of reach right now is greyed.
  const full = { min: limits.minSide, max: sideRange(limits.minSide, limits).longest };
  const widthRange = sideRange(size.height, limits);
  const heightRange = sideRange(size.width, limits);
  const set = (side: keyof Dimensions) => (value: number) =>
    setSize((current) => ({ ...current, [side]: value }));

  const portrait = size.height > size.width;
  const currentRatio = size.width / size.height;

  // One list per user; a size this model can't take shows greyed, with why.
  const sizePresets = useSizePresets(limits);
  // What Save stores is what Apply would send: a typed side mid-entry is fitted first.
  const fitted = fitCustomDimensions(size, limits);
  const alreadySaved =
    !!fitted &&
    sizePresets.presets.some((p) => p.width === fitted.width && p.height === fitted.height);

  const finish = (dimensions: Dimensions | null) => {
    onResolve(dimensions);
    dialog.onClose();
  };
  // Typing can leave a side mid-entry or past its range; Apply sends the fitted size.
  const apply = () => finish(fitCustomDimensions(size, limits) ?? null);

  const preview = (() => {
    const box = 96;
    const ratio = size.width / size.height;
    return ratio >= 1 ? { width: box, height: box / ratio } : { width: box * ratio, height: box };
  })();
  const megapixels = megapixelsOf(size.width * size.height);
  // Nothing above Apply may change height between pressing and releasing it: a typed
  // side clamps on blur, and a line that came or went with it moved Apply out from
  // under the pointer. Hence the footer below recolours rather than appears.
  const limit =
    (size.width >= widthRange.max && limitNote('width', widthRange, limits)) ||
    (size.height >= heightRange.max && limitNote('height', heightRange, limits)) ||
    undefined;
  // Past the recommended area is allowed, and sent — only flagged.
  const aboveRecommended = size.width * size.height > limits.recommendedArea;

  return (
    <Modal {...dialog} onClose={() => finish(null)} title="Custom size" size="sm" centered>
      <Stack gap="md">
        {/* The output, first and largest: what the user is choosing is a size, and the
            megapixels are what the recommendation is about. A 104px floor so the box
            reshaping as the sides change never moves the controls under it. */}
        <Group gap="lg" wrap="nowrap" style={{ minHeight: 104 }} align="center">
          <div
            className="flex shrink-0 items-center justify-center"
            style={{ width: 96, height: 96 }}
          >
            <Paper
              withBorder
              style={{ borderWidth: 2, width: preview.width, height: preview.height }}
            />
          </div>
          <Stack gap={6}>
            {/* nowrap: "2048 × 1152" wrapping onto two lines is the readout at its worst. */}
            <Text
              fz={26}
              fw={700}
              lh={1}
              style={{ whiteSpace: 'nowrap' }}
              data-testid="custom-size-readout"
            >
              {size.width} × {size.height}
            </Text>
            <Badge
              size="lg"
              variant="light"
              color={aboveRecommended ? 'yellow' : 'green'}
              data-testid="custom-size-megapixels"
            >
              {megapixels} MP
            </Badge>
          </Stack>
        </Group>

        {sizePresets.presets.length > 0 && (
          <Stack gap={4}>
            <Text size="xs" c="dimmed">
              Saved
            </Text>
            <Group gap={6}>
              {/* Smallest to largest, so the sizes read as a scale. */}
              {[...sizePresets.presets]
                .sort((a, b) => a.width * a.height - b.width * b.height || a.width - b.width)
                .map((preset) => {
                  const active = preset.width === size.width && preset.height === size.height;
                  const label = `${preset.width} × ${preset.height}`;
                  return (
                    <Button.Group key={preset.id}>
                      <Button
                        size="compact-sm"
                        variant={active ? 'filled' : 'default'}
                        aria-pressed={active}
                        disabled={!preset.fits}
                        title={
                          preset.fits
                            ? undefined
                            : `Doesn't fit this model — up to ${megapixelsOf(limits.maxArea)} MP, ${
                                limits.minSide
                              }–${limits.maxSide} per side`
                        }
                        onClick={() => setSize({ width: preset.width, height: preset.height })}
                      >
                        {label}
                      </Button>
                      <Button
                        size="compact-sm"
                        variant="default"
                        px={6}
                        aria-label={`Remove saved size ${label}`}
                        title="Remove"
                        onClick={() => sizePresets.remove(preset.id)}
                      >
                        <IconX size={14} />
                      </Button>
                    </Button.Group>
                  );
                })}
            </Group>
          </Stack>
        )}

        {/* Change the shape, keep the size — swap included. */}
        <Group gap={6}>
          <Button
            size="compact-sm"
            variant="default"
            px={6}
            aria-label="Swap width and height"
            title="Swap width and height"
            onClick={() => setSize(({ width, height }) => ({ width: height, height: width }))}
          >
            <IconArrowsLeftRight size={16} />
          </Button>
          {QUICK_RATIOS.map(([a, b]) => {
            const ratio = portrait ? b / a : a / b;
            const label = portrait ? `${b}:${a}` : `${a}:${b}`;
            const active = Math.abs(currentRatio - ratio) / ratio < 0.03;
            return (
              <Button
                key={`${a}:${b}`}
                size="compact-sm"
                variant={active ? 'filled' : 'default'}
                aria-pressed={active}
                onClick={() => {
                  const next = atRatio(size, ratio, limits);
                  if (next) setSize(next);
                }}
              >
                {label}
              </Button>
            );
          })}
        </Group>

        <Stack gap="xs">
          <SideSlider
            label="Width"
            value={size.width}
            onChange={set('width')}
            full={full}
            allowed={widthRange}
            step={limits.step}
          />
          <SideSlider
            label="Height"
            value={size.height}
            onChange={set('height')}
            full={full}
            allowed={heightRange}
            step={limits.step}
          />
        </Stack>

        {/* Shown only at a slider's end, and a side clamped on blur is still at its end,
            so this line doesn't come or go between pressing Apply and releasing it. */}
        {limit && (
          <Text size="xs" c="dimmed" aria-live="polite">
            {limit}
          </Text>
        )}
        <Stack gap={2}>
          <Text size="xs" c="dimmed">
            Multiples of {limits.step}, {limits.minSide}–{limits.maxSide} per side, at most{' '}
            {megapixelsOf(limits.maxArea)} MP.
          </Text>
          {/* Always one line, recoloured rather than shown or hidden: a line appearing
              above Apply as a typed side clamps on blur moves Apply mid-click. */}
          <Text size="xs" c={aboveRecommended ? 'yellow' : 'dimmed'} lineClamp={1}>
            {aboveRecommended
              ? `Above the recommended ${megapixelsOf(
                  limits.recommendedArea
                )} MP — results may degrade.`
              : `Recommended up to ${megapixelsOf(limits.recommendedArea)} MP.`}
          </Text>
        </Stack>
        <Group justify="space-between">
          {/* Saves what Apply would send, for every model in this size group. */}
          {sizePresets.canSave ? (
            <Button
              // Bordered like Cancel: subtle read as a text label sitting in the footer.
              variant="default"
              leftSection={<IconBookmark size={16} />}
              disabled={!fitted || alreadySaved}
              loading={sizePresets.saving}
              onClick={() => fitted && sizePresets.save(fitted)}
            >
              {alreadySaved ? 'Saved' : 'Save size'}
            </Button>
          ) : (
            <span />
          )}
          <Group gap="xs">
            <Button variant="default" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button onClick={apply}>Apply</Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

const DIALOG_ID = 'custom-dimensions';

/**
 * Opens the editor; resolves to the fitted size, or null when it is dismissed. A
 * call while it is already open resolves null at once: dialogStore ignores a
 * trigger whose id is open, so that promise would otherwise never settle.
 */
export function openCustomDimensionsModal(props: {
  initial: Dimensions;
  limits: CustomDimensionLimits;
}) {
  if (useDialogStore.getState().dialogs.some((d) => d.id === DIALOG_ID))
    return Promise.resolve(null);
  return new Promise<Dimensions | null>((resolve) => {
    let settled = false;
    const settle = (dimensions: Dimensions | null) => {
      if (settled) return;
      settled = true;
      resolve(dimensions);
    };
    dialogStore.trigger({
      id: DIALOG_ID,
      component: CustomDimensionsModal,
      props: { ...props, onResolve: settle },
      // Escape, the overlay or a route change close it without reaching onResolve.
      options: { onClose: () => settle(null) },
    });
  });
}
