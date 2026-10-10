import type { InputWrapperProps } from '@mantine/core';
import { Input, Paper } from '@mantine/core';
import { IconDots } from '@tabler/icons-react';
import { useCallback, useMemo } from 'react';
import { CUSTOM_ASPECT_RATIO } from '~/shared/constants/generation.constants';
import type { CustomDimensionLimits } from '~/utils/aspect-ratio-helpers';
import { openCustomDimensionsModal } from './CustomDimensionsModal';
import { useSizePresets, type SizePreset } from './useSizePresets';

/** A saved size's option value: not a ratio label, and never sent as one. */
const SAVED_PREFIX = 'saved:';
const savedValue = (preset: SizePreset) => `${SAVED_PREFIX}${preset.id}`;

import {
  OverflowSegmentedControl,
  type OverflowSegmentedControlOption,
} from './OverflowSegmentedControl';

// =============================================================================
// Types
// =============================================================================

export interface AspectRatioOption {
  /** Aspect ratio string (e.g., "16:9", "1:1") */
  value: string;
  /** Optional width for display purposes */
  width?: number;
  /** Optional height for display purposes */
  height?: number;
}

/** Value type for AspectRatioInput - includes resolved dimensions */
export interface AspectRatioValue {
  value: string;
  width: number;
  height: number;
}

export interface AspectRatioInputProps extends Omit<InputWrapperProps, 'children' | 'onChange'> {
  value?: AspectRatioValue;
  onChange?: (value: AspectRatioValue) => void;
  options: AspectRatioOption[];
  disabled?: boolean;
  /** Maximum number of options to show before displaying "More" button (default: 5) */
  maxVisible?: number;
  /** Priority aspect ratio values to show before "More" button. When set, these values are shown instead of the first N options. */
  priorityOptions?: string[];
  /** When set, "Custom" joins the options and opens a width × height modal held to these limits. */
  custom?: CustomDimensionLimits;
}

// =============================================================================
// Helpers
// =============================================================================

function parseRatio(ratio: string): { width: number; height: number } {
  const [w, h] = ratio.split(':').map(Number);
  return { width: w || 1, height: h || 1 };
}

/**
 * Fit the preview box into a max width/height while preserving the aspect
 * ratio. Wide ratios (21:9) would otherwise blow past the segmented-control
 * column edges; very narrow ones would dominate vertical space.
 */
function getPreviewDimensions(option: AspectRatioOption, maxWidth: number, maxHeight: number) {
  const parsed = parseRatio(option.value);
  const w = option.width ?? parsed.width;
  const h = option.height ?? parsed.height;
  const ratio = w / h;
  let width = maxHeight * ratio;
  let height = maxHeight;
  if (width > maxWidth) {
    width = maxWidth;
    height = maxWidth / ratio;
  }
  return { width, height };
}

function getDimensionsLabel(option: AspectRatioOption): string | null {
  if (option.width && option.height) {
    return `${option.width}x${option.height}`;
  }
  return null;
}

/**
 * Widest first, tallest last. Ecosystems declare their options in whatever order
 * their graph was written in (some portrait-first, some landscape-first, a few
 * neither), so the picker imposes one order rather than trusting each list.
 * Stable, so two options with the same ratio keep their declared order.
 */
function sortWidestFirst(options: AspectRatioOption[]): AspectRatioOption[] {
  const ratio = (option: AspectRatioOption) => {
    const { width, height } = optionToValue(option);
    return width / height;
  };
  return [...options].sort((a, b) => ratio(b) - ratio(a));
}

/** Helper to convert an option to an AspectRatioValue */
function optionToValue(option: AspectRatioOption): AspectRatioValue {
  const parsed = parseRatio(option.value);
  return {
    value: option.value,
    width: option.width ?? parsed.width,
    height: option.height ?? parsed.height,
  };
}

// =============================================================================
// Option Display Component (for segmented control)
// =============================================================================

interface AspectRatioOptionDisplayProps {
  option: AspectRatioOption;
  showDimensions?: boolean;
}

function AspectRatioOptionDisplay({
  option,
  showDimensions = true,
}: AspectRatioOptionDisplayProps) {
  const dimensions = getDimensionsLabel(option);
  const preview = getPreviewDimensions(option, 36, 20);

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex h-5 items-center justify-center">
        <Paper
          withBorder
          style={{ borderWidth: 2, width: preview.width, height: preview.height }}
        />
      </div>
      <span className="text-xs">{option.value}</span>
      {showDimensions && dimensions && (
        <span className="text-[10px] text-gray-6 dark:text-dark-2">{dimensions}</span>
      )}
    </div>
  );
}

// =============================================================================
// Modal Option Display Component
// =============================================================================

interface ModalOptionDisplayProps {
  option: AspectRatioOption;
  selected: boolean;
  /** The phone bottom sheet: taller rows, bigger text and preview, for a thumb. */
  inSheet: boolean;
}

function ModalOptionDisplay({ option, selected, inSheet }: ModalOptionDisplayProps) {
  const dimensions = getDimensionsLabel(option);
  const preview = inSheet
    ? getPreviewDimensions(option, 64, 32)
    : getPreviewDimensions(option, 48, 24);

  return (
    <div className={`flex w-full items-center px-3 ${inSheet ? 'gap-4 py-3.5' : 'gap-3 py-2'}`}>
      <div
        className={`flex shrink-0 items-center justify-center ${inSheet ? 'h-8 w-16' : 'h-6 w-12'}`}
      >
        <Paper
          withBorder
          style={{ borderWidth: 2, width: preview.width, height: preview.height }}
        />
      </div>
      <span
        className={`flex-1 text-left ${inSheet ? 'text-base' : 'text-sm'} ${
          selected ? 'font-semibold' : 'font-normal'
        }`}
      >
        {option.value}
      </span>
      {dimensions && (
        <span className={`${inSheet ? 'text-sm' : 'text-xs'} text-gray-6 dark:text-dark-2`}>
          {dimensions}
        </span>
      )}
    </div>
  );
}

// =============================================================================
// Custom width × height
// =============================================================================

function CustomOptionDisplay({ value }: { value?: AspectRatioValue }) {
  const current = value?.value === CUSTOM_ASPECT_RATIO ? value : undefined;
  const preview = getPreviewDimensions(current ?? { value: '1:1' }, 36, 20);
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex h-5 items-center justify-center">
        <Paper
          withBorder
          style={{
            borderWidth: 2,
            width: preview.width,
            height: preview.height,
          }}
        />
      </div>
      <span className="text-xs">Custom</span>
      {current && (
        <span className="text-[10px] text-gray-6 dark:text-dark-2">
          {getDimensionsLabel(current)}
        </span>
      )}
    </div>
  );
}

function SavedModalOption({ preset, inSheet }: { preset: SizePreset; inSheet: boolean }) {
  const preview = getPreviewDimensions(
    { value: '', width: preset.width, height: preset.height },
    inSheet ? 64 : 48,
    inSheet ? 32 : 24
  );
  return (
    <div className={`flex w-full items-center px-3 ${inSheet ? 'gap-4 py-3.5' : 'gap-3 py-2'}`}>
      <div
        className={`flex shrink-0 items-center justify-center ${inSheet ? 'h-8 w-16' : 'h-6 w-12'}`}
      >
        <Paper
          withBorder
          style={{ borderWidth: 2, width: preview.width, height: preview.height }}
        />
      </div>
      <span className={`flex-1 text-left ${inSheet ? 'text-base' : 'text-sm'}`}>
        {preset.width} × {preset.height}
      </span>
      <span className={`${inSheet ? 'text-sm' : 'text-xs'} text-gray-6 dark:text-dark-2`}>
        Saved
      </span>
    </div>
  );
}

function CustomModalOption({ selected, inSheet }: { selected: boolean; inSheet: boolean }) {
  const box = inSheet ? 32 : 24;
  return (
    <div className={`flex w-full items-center px-3 ${inSheet ? 'gap-4 py-3.5' : 'gap-3 py-2'}`}>
      <div
        className={`flex shrink-0 items-center justify-center ${inSheet ? 'h-8 w-16' : 'h-6 w-12'}`}
      >
        <Paper withBorder style={{ borderWidth: 2, width: box, height: box }} />
      </div>
      <span
        className={`flex-1 text-left ${inSheet ? 'text-base' : 'text-sm'} ${
          selected ? 'font-semibold' : 'font-normal'
        }`}
      >
        Custom
      </span>
      <span className={`${inSheet ? 'text-sm' : 'text-xs'} text-gray-6 dark:text-dark-2`}>
        Width × height
      </span>
    </div>
  );
}

// =============================================================================
// More Button Content
// =============================================================================

function MoreButtonContent() {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex h-5 items-center justify-center">
        <Paper withBorder style={{ borderWidth: 2, aspectRatio: '1/1', height: 20 }} />
      </div>
      <span className="text-xs">More</span>
      <span className="text-[10px] text-gray-6 dark:text-dark-2">
        <IconDots size={16} className="mx-auto" />
      </span>
    </div>
  );
}

// =============================================================================
// Component
// =============================================================================

const DEFAULT_MAX_VISIBLE = 5;

export function AspectRatioInput({
  value,
  onChange,
  options: declaredOptions,
  label,
  disabled,
  maxVisible = DEFAULT_MAX_VISIBLE,
  priorityOptions,
  custom,
  ...inputWrapperProps
}: AspectRatioInputProps) {
  // Extract the value string from the value object
  const selectedAspectRatio = value?.value;

  const options = useMemo(() => sortWidestFirst(declaredOptions), [declaredOptions]);
  // Only the sizes this model accepts: More is for picking, not explaining.
  const savedSizes = useSizePresets(custom).presets.filter((preset) => preset.fits);

  // Without explicit priorityOptions, a list too long for the row shows its middle
  // — the extremes (21:9, 9:21) go behind More rather than squeezing out 1:1.
  const rowOptions = useMemo(
    () =>
      priorityOptions ??
      (options.length > maxVisible
        ? options.slice(1, maxVisible + 1).map((option) => option.value)
        : undefined),
    [priorityOptions, options, maxVisible]
  );

  // Convert AspectRatioOption[] to OverflowSegmentedControlOption[]. "Custom" goes
  // last: it is not a ratio, so it has no place in the widest-first order.
  const segmentedOptions: OverflowSegmentedControlOption<string>[] = [
    // With Custom on offer, More splits into the model's own presets and the
    // user's sizes; without it, one list with no headings, as before.
    ...options.map((option) => ({
      value: option.value,
      label: <AspectRatioOptionDisplay option={option} />,
      section: custom ? 'Presets' : undefined,
    })),
    ...(custom
      ? [
          {
            value: CUSTOM_ASPECT_RATIO,
            label: <CustomOptionDisplay value={value} />,
            section: 'Custom',
          },
        ]
      : []),
    // Saved sizes follow Custom: one tap sets that size, no modal.
    ...savedSizes.map((preset) => ({
      value: savedValue(preset),
      label: `${preset.width} × ${preset.height}`,
      section: 'Custom',
      // Picking one selects Custom at that size; the saved size itself is never a segment.
      overflowOnly: true,
    })),
  ];

  // Render the More button
  const renderMoreButton = useCallback(() => <MoreButtonContent />, []);

  // Render modal option
  const renderModalOption = useCallback(
    (option: OverflowSegmentedControlOption<string>, selected: boolean, inSheet: boolean) => {
      if (option.value === CUSTOM_ASPECT_RATIO)
        return <CustomModalOption selected={selected} inSheet={inSheet} />;
      const saved = savedSizes.find((preset) => savedValue(preset) === option.value);
      if (saved) return <SavedModalOption preset={saved} inSheet={inSheet} />;
      const aspectOption = options.find((opt) => opt.value === option.value);
      if (!aspectOption) return null;
      return <ModalOptionDisplay option={aspectOption} selected={selected} inSheet={inSheet} />;
    },
    [options, savedSizes]
  );

  // Opens on the size already chosen, so a bucket the user liked is the starting
  // point. Nothing changes until Apply: dismissing it leaves the previous pick.
  const editCustom = useCallback(async () => {
    if (!custom || disabled) return;
    const initial = { width: value?.width ?? 1024, height: value?.height ?? 1024 };
    const fit = await openCustomDimensionsModal({ initial, limits: custom });
    if (fit) onChange?.({ value: CUSTOM_ASPECT_RATIO, ...fit });
  }, [custom, disabled, value?.width, value?.height, onChange]);

  // Handle value change - convert string to AspectRatioValue
  const handleChange = useCallback(
    (newValue: string) => {
      if (newValue === CUSTOM_ASPECT_RATIO && custom) {
        editCustom();
        return;
      }
      const saved = savedSizes.find((preset) => savedValue(preset) === newValue);
      if (saved) {
        onChange?.({ value: CUSTOM_ASPECT_RATIO, width: saved.width, height: saved.height });
        return;
      }
      const option = options.find((opt) => opt.value === newValue);
      if (option) {
        onChange?.(optionToValue(option));
      }
    },
    [options, onChange, custom, editCustom, savedSizes]
  );

  return (
    <Input.Wrapper {...inputWrapperProps} label={label}>
      <OverflowSegmentedControl
        value={selectedAspectRatio}
        onChange={handleChange}
        options={segmentedOptions}
        disabled={disabled}
        maxVisible={maxVisible}
        priorityOptions={rowOptions}
        renderMoreButton={renderMoreButton}
        renderOption={renderModalOption}
        gridColumns={1}
        drawerTitle={label ?? 'Aspect ratio'}
        onReselect={(selected) => selected === CUSTOM_ASPECT_RATIO && editCustom()}
      />
    </Input.Wrapper>
  );
}
