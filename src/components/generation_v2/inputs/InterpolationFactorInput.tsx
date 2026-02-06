/**
 * InterpolationFactorInput
 *
 * A form input component for selecting video interpolation factor (x2, x3, x4).
 * Shows available options based on the source video's FPS and the maximum output FPS.
 * Displays the estimated target FPS for the selected option.
 */

import { Alert, Group, Input, Radio, Text } from '@mantine/core';
import type { InputWrapperProps } from '@mantine/core';

// =============================================================================
// Types
// =============================================================================

export type InterpolationOption = {
  value: number;
  label: string;
  disabled: boolean;
  targetFps: number;
};

export interface InterpolationFactorInputMeta {
  options: InterpolationOption[];
  canInterpolate: boolean;
  sourceFps?: number;
  maxOutputFps: number;
}

export interface InterpolationFactorInputProps
  extends Omit<InputWrapperProps, 'children' | 'onChange'> {
  value?: number;
  onChange?: (value: number) => void;
  meta: InterpolationFactorInputMeta;
  /** Target FPS to display (calculated externally) */
  targetFps?: number;
  /** Whether the input is disabled */
  disabled?: boolean;
}

// =============================================================================
// Component
// =============================================================================

export function InterpolationFactorInput({
  value,
  onChange,
  meta,
  targetFps,
  label = 'Interpolation Factor',
  description,
  error,
  required,
  disabled,
  ...inputWrapperProps
}: InterpolationFactorInputProps) {
  const { options, canInterpolate, sourceFps, maxOutputFps } = meta;

  // If source FPS is not yet available, show loading state
  if (sourceFps === undefined) {
    return (
      <Input.Wrapper {...inputWrapperProps} label={label} description={description}>
        <Text c="dimmed" size="sm">
          Waiting for video metadata...
        </Text>
      </Input.Wrapper>
    );
  }

  // If video cannot be interpolated further
  if (!canInterpolate) {
    return (
      <Alert color="yellow">
        This video cannot be interpolated further. The source FPS ({sourceFps}) is too high for the
        maximum output of {maxOutputFps} FPS.
      </Alert>
    );
  }

  return (
    <Input.Wrapper
      {...inputWrapperProps}
      label={label}
      description={description}
      error={error}
      required={required}
    >
      <div className="flex flex-col gap-3">
        {/* Radio options */}
        <Radio.Group value={value?.toString()} onChange={(val) => onChange?.(parseInt(val, 10))}>
          <Group gap="sm">
            {options.map((option) => (
              <Radio
                key={option.value}
                value={option.value.toString()}
                label={option.label}
                disabled={disabled || option.disabled}
              />
            ))}
          </Group>
        </Radio.Group>

        {/* Target FPS display */}
        {targetFps !== undefined && (
          <div className="rounded-md bg-gray-2 px-4 py-3 dark:bg-dark-6">
            <Text size="sm">
              <span className="font-semibold">Target FPS:</span> {targetFps}
            </Text>
            {targetFps > maxOutputFps && (
              <Text size="xs" c="red" className="mt-1">
                Exceeds maximum output FPS ({maxOutputFps})
              </Text>
            )}
          </div>
        )}
      </div>
    </Input.Wrapper>
  );
}
