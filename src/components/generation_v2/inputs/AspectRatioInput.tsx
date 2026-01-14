import type { InputWrapperProps } from '@mantine/core';
import { Center, Input, Paper, Stack, Text } from '@mantine/core';
import { IconDots, IconLibraryPlus } from '@tabler/icons-react';
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

function getAspectRatioStyle(option: AspectRatioOption): string {
  if (option.width && option.height) {
    return `${option.width}/${option.height}`;
  }
  const { width, height } = parseRatio(option.value);
  return `${width}/${height}`;
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

  return (
    <Stack gap={2}>
      <Center>
        <Paper
          withBorder
          style={{ borderWidth: 2, aspectRatio: getAspectRatioStyle(option), height: 20 }}
        />
      </Center>
      <Stack gap={0}>
        <Text size="xs">{option.value}</Text>
        {showDimensions && dimensions && (
          <Text fz={10} c="dimmed">
            {dimensions}
          </Text>
        )}
      </Stack>
    </Stack>
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

  return (
    <div className="flex flex-col items-center gap-2 p-3">
      <Paper
        withBorder
        style={{ borderWidth: 2, aspectRatio: getAspectRatioStyle(option), height: 40 }}
      />
      <Stack gap={0} align="center">
        <Text size="sm" fw={selected ? 600 : 400}>
          {option.value}
        </Text>
        {dimensions && (
          <Text fz="xs" c="dimmed">
            {dimensions}
          </Text>
        )}
      </Stack>
    </div>
  );
}

// =============================================================================
// More Button Content
// =============================================================================

interface MoreButtonContentProps {
  hiddenOption?: AspectRatioOption;
}

function MoreButtonContent({ hiddenOption }: MoreButtonContentProps) {
  const dimensionLabel = hiddenOption ? getDimensionsLabel(hiddenOption) : undefined;

  return (
    <Stack gap={2}>
      {hiddenOption && (
        <Text c="dimmed" className="absolute right-0.5 top-0.5">
          <IconLibraryPlus size={18} />
        </Text>
      )}
      <Center>
        <Paper
          withBorder
          style={{
            borderWidth: 2,
            aspectRatio: hiddenOption ? getAspectRatioStyle(hiddenOption) : '1/1',
            height: 20,
          }}
        />
      </Center>
      <Stack gap={0}>
        <Text size="xs">{hiddenOption ? hiddenOption.value : 'More'}</Text>
        <Text fz={10} c="dimmed">
          {dimensionLabel ?? <IconDots size={16} className="mx-auto" />}
        </Text>
      </Stack>
    </Stack>
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

  // Render the More button with hidden selection info
  const renderMoreButton = useCallback(
    (hiddenSelectedValue: string | undefined) => {
      const hiddenOption = hiddenSelectedValue
        ? options.find((opt) => opt.value === hiddenSelectedValue)
        : undefined;
      return <MoreButtonContent hiddenOption={hiddenOption} />;
    },
    [options]
  );

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
        renderModalOption={renderModalOption}
        modalTitle="Select Aspect Ratio"
      />
    </Input.Wrapper>
  );
}
