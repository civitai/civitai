import type { InputWrapperProps } from '@mantine/core';
import { Input, Paper } from '@mantine/core';
import { IconDots } from '@tabler/icons-react';
import { useCallback } from 'react';

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
}

function ModalOptionDisplay({ option, selected }: ModalOptionDisplayProps) {
  const dimensions = getDimensionsLabel(option);
  const preview = getPreviewDimensions(option, 48, 24);

  return (
    <div className="flex w-full items-center gap-3 px-3 py-2">
      <div className="flex h-6 w-12 shrink-0 items-center justify-center">
        <Paper
          withBorder
          style={{ borderWidth: 2, width: preview.width, height: preview.height }}
        />
      </div>
      <span className={`flex-1 text-left text-sm ${selected ? 'font-semibold' : 'font-normal'}`}>
        {option.value}
      </span>
      {dimensions && <span className="text-xs text-gray-6 dark:text-dark-2">{dimensions}</span>}
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
  options,
  label,
  disabled,
  maxVisible = DEFAULT_MAX_VISIBLE,
  priorityOptions,
  ...inputWrapperProps
}: AspectRatioInputProps) {
  // Extract the value string from the value object
  const selectedAspectRatio = value?.value;

  // Convert AspectRatioOption[] to OverflowSegmentedControlOption[]
  const segmentedOptions: OverflowSegmentedControlOption<string>[] = options.map((option) => ({
    value: option.value,
    label: <AspectRatioOptionDisplay option={option} />,
  }));

  // Render the More button
  const renderMoreButton = useCallback(() => <MoreButtonContent />, []);

  // Render modal option
  const renderModalOption = useCallback(
    (option: OverflowSegmentedControlOption<string>, selected: boolean) => {
      const aspectOption = options.find((opt) => opt.value === option.value);
      if (!aspectOption) return null;
      return <ModalOptionDisplay option={aspectOption} selected={selected} />;
    },
    [options]
  );

  // Handle value change - convert string to AspectRatioValue
  const handleChange = useCallback(
    (newValue: string) => {
      const option = options.find((opt) => opt.value === newValue);
      if (option) {
        onChange?.(optionToValue(option));
      }
    },
    [options, onChange]
  );

  return (
    <Input.Wrapper {...inputWrapperProps} label={label}>
      <OverflowSegmentedControl
        value={selectedAspectRatio}
        onChange={handleChange}
        options={segmentedOptions}
        disabled={disabled}
        maxVisible={maxVisible}
        priorityOptions={priorityOptions}
        renderMoreButton={renderMoreButton}
        renderOption={renderModalOption}
        gridColumns={1}
      />
    </Input.Wrapper>
  );
}
