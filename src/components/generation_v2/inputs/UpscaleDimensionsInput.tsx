import { Alert, Input } from '@mantine/core';
import { Radio } from '~/libs/form/components/RadioGroup';
import type {
  UpscaleMultiplierOption,
  UpscaleResolutionOption,
  UpscaleSelection,
  UpscaleSelectionMeta,
} from '~/shared/data-graph/generation/image-upscale-graph';

// =============================================================================
// Types
// =============================================================================

export interface UpscaleDimensionsInputProps {
  value?: UpscaleSelection;
  onChange?: (value: UpscaleSelection) => void;
  meta: UpscaleSelectionMeta;
  disabled?: boolean;
}

// =============================================================================
// Component
// =============================================================================

export function UpscaleDimensionsInput({
  value,
  onChange,
  meta,
  disabled,
}: UpscaleDimensionsInputProps) {
  const { sourceWidth, sourceHeight, maxOutputResolution, multiplierOptions, resolutionOptions } =
    meta;

  // Derive target dimensions from the selected option in meta
  const targetDimensions = getSelectedDimensions(value, multiplierOptions, resolutionOptions);

  if (!sourceWidth || !sourceHeight) {
    return (
      <Input.Wrapper label="Upscale">
        <div className="text-dimmed text-sm">Waiting for source dimensions...</div>
      </Input.Wrapper>
    );
  }

  if (!meta.canUpscale) {
    return (
      <Input.Wrapper label="Upscale">
        <Alert color="yellow">
          This image cannot be upscaled further. Maximum output resolution is {maxOutputResolution}
          px.
        </Alert>
      </Input.Wrapper>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {multiplierOptions.length > 0 && (
        <MultiplierGroup
          options={multiplierOptions}
          selected={value?.type === 'multiplier' ? value.multiplier : null}
          onSelect={(multiplier) => onChange?.({ type: 'multiplier', multiplier })}
          disabled={disabled}
        />
      )}

      {resolutionOptions.length > 0 && (
        <ResolutionGroup
          options={resolutionOptions}
          selected={value?.type === 'resolution' ? value.resolution : null}
          onSelect={(resolution) => onChange?.({ type: 'resolution', resolution })}
          disabled={disabled}
        />
      )}

      {/* Display source and target dimensions */}
      <div className="rounded-md bg-gray-2 px-4 py-3 dark:bg-dark-6">
        <div className="flex justify-between text-sm">
          <span className="text-dimmed">Source:</span>
          <span>
            {sourceWidth} × {sourceHeight}
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

// =============================================================================
// Option Groups
// =============================================================================

function MultiplierGroup({
  options,
  selected,
  onSelect,
  disabled,
}: {
  options: UpscaleMultiplierOption[];
  selected: number | null;
  onSelect: (multiplier: number) => void;
  disabled?: boolean;
}) {
  return (
    <Input.Wrapper label="Upscale Multiplier">
      <Radio.Group
        value={selected}
        onChange={(v: number) => onSelect(v)}
        className="flex gap-2"
        disabled={disabled}
      >
        {options.map((option) => (
          <Radio.Item
            key={option.multiplier}
            value={option.multiplier}
            label={option.label}
            disabled={option.disabled}
          />
        ))}
      </Radio.Group>
    </Input.Wrapper>
  );
}

function getSelectedDimensions(
  value: UpscaleSelection | undefined,
  multiplierOptions: UpscaleMultiplierOption[],
  resolutionOptions: UpscaleResolutionOption[]
): { width: number; height: number } | undefined {
  if (!value) return undefined;
  if (value.type === 'multiplier') {
    const option = multiplierOptions.find((o) => o.multiplier === value.multiplier);
    return option ? { width: option.width, height: option.height } : undefined;
  }
  const option = resolutionOptions.find((o) => o.resolution === value.resolution);
  return option ? { width: option.width, height: option.height } : undefined;
}

function ResolutionGroup({
  options,
  selected,
  onSelect,
  disabled,
}: {
  options: UpscaleResolutionOption[];
  selected: number | null;
  onSelect: (resolution: number) => void;
  disabled?: boolean;
}) {
  return (
    <Input.Wrapper label="Upscale Resolution">
      <Radio.Group
        value={selected}
        onChange={(v: number) => onSelect(v)}
        className="flex gap-2"
        disabled={disabled}
      >
        {options.map((option) => (
          <Radio.Item
            key={option.resolution}
            value={option.resolution}
            label={option.label}
            disabled={option.disabled}
          />
        ))}
      </Radio.Group>
    </Input.Wrapper>
  );
}
