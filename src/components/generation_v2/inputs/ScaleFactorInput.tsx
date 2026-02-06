import { Alert, Input } from '@mantine/core';
import { useMemo } from 'react';
import { Radio } from '~/libs/form/components/RadioGroup';

// =============================================================================
// Types
// =============================================================================

export interface ScaleFactorOption {
  value: number;
  label: string;
  disabled?: boolean;
  targetWidth: number;
  targetHeight: number;
}

export interface ScaleFactorInputProps {
  value?: number;
  onChange?: (value: number) => void;
  /** Source width of the media */
  width?: number;
  /** Source height of the media */
  height?: number;
  /** Maximum output resolution (longest side) */
  maxResolution: number;
  /** Available scale factor options */
  options: ScaleFactorOption[];
  disabled?: boolean;
  label?: string;
}

// =============================================================================
// Component
// =============================================================================

export function ScaleFactorInput({
  value,
  onChange,
  width,
  height,
  maxResolution,
  options,
  disabled,
  label = 'Scale Factor',
}: ScaleFactorInputProps) {
  // Calculate if upscaling is possible based on dimensions
  const { canUpscale, computedOptions, targetDimensions } = useMemo(() => {
    const maxDimension = width && height ? Math.max(width, height) : undefined;
    const multipliers = options.map((o) => o.value);
    const minMultiplier = Math.min(...multipliers);

    // Determine if any upscale is possible
    const canUpscale = maxDimension ? maxDimension * minMultiplier <= maxResolution : true;

    // Compute disabled state for each option based on dimensions
    const computedOptions = options.map((option) => ({
      ...option,
      disabled:
        option.disabled || (maxDimension ? option.value * maxDimension > maxResolution : false),
    }));

    // Calculate target dimensions for the current selection
    const targetDimensions =
      value && width && height ? { width: value * width, height: value * height } : undefined;

    return { canUpscale, computedOptions, targetDimensions };
  }, [width, height, maxResolution, options, value]);

  // If dimensions aren't available yet, show loading state
  if (!width || !height) {
    return (
      <Input.Wrapper label={label}>
        <div className="text-dimmed text-sm">Waiting for source dimensions...</div>
      </Input.Wrapper>
    );
  }

  // If upscaling is not possible, show alert
  if (!canUpscale) {
    return (
      <Input.Wrapper label={label}>
        <Alert color="yellow">
          This media cannot be upscaled further. Maximum output resolution is {maxResolution}px.
        </Alert>
      </Input.Wrapper>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Input.Wrapper label={label}>
        <Radio.Group
          value={value}
          onChange={(v) => onChange?.(v as number)}
          className="flex gap-2"
          disabled={disabled}
        >
          {computedOptions.map(({ label, value: optionValue, disabled: optionDisabled }) => (
            <Radio.Item
              key={optionValue}
              value={optionValue}
              label={label}
              disabled={optionDisabled}
            />
          ))}
        </Radio.Group>
      </Input.Wrapper>

      {/* Display source and target dimensions */}
      <div className="rounded-md bg-gray-2 px-4 py-3 dark:bg-dark-6">
        <div className="flex justify-between text-sm">
          <span className="text-dimmed">Source:</span>
          <span>
            {width} × {height}
          </span>
        </div>
        {targetDimensions && (
          <div className="flex justify-between text-sm">
            <span className="font-medium">Upscaled:</span>
            <span className="font-medium">
              {targetDimensions.width} × {targetDimensions.height}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
