import type { SelectProps } from '@mantine/core';
import { Group, Input, Select } from '@mantine/core';
import clsx from 'clsx';

// =============================================================================
// Types
// =============================================================================

interface PresetOption {
  label: string;
  value: string;
}

export interface SelectInputProps<V extends string = string>
  extends Omit<SelectProps, 'value' | 'onChange'> {
  value?: V | null;
  onChange?: (value: V) => void;
  presets?: PresetOption[];
  /** Alternative to `data` - will be mapped to `data` for Mantine Select */
  options?: SelectProps['data'];
}

// =============================================================================
// Preset Options Component
// =============================================================================

interface PresetOptionsProps {
  options: PresetOption[];
  value?: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
}

function PresetOptions({ options, value, onChange, disabled }: PresetOptionsProps) {
  return (
    <Group gap={4}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          disabled={disabled}
          className={clsx(
            'rounded px-2 py-0.5 text-xs transition-colors',
            value === option.value
              ? 'bg-blue-6 text-white'
              : 'bg-gray-1 text-gray-7 hover:bg-gray-2 dark:bg-dark-5 dark:text-gray-4 dark:hover:bg-dark-4'
          )}
        >
          {option.label}
        </button>
      ))}
    </Group>
  );
}

// =============================================================================
// Component
// =============================================================================

export function SelectInput<V extends string = string>({
  value,
  onChange,
  presets,
  label,
  disabled,
  options,
  data,
  ...props
}: SelectInputProps<V>) {
  const hasPresets = presets && presets.length > 0;
  // Support both `options` and `data` - prefer `data` if both provided
  const selectData = data ?? options;

  return (
    <Input.Wrapper
      label={
        hasPresets ? (
          <Group gap={8} className="w-full" justify="space-between" wrap="nowrap">
            {label}
            <PresetOptions
              disabled={disabled}
              options={presets}
              value={value}
              // preset/select values come from this component's own options,
              // so the string really is a V
              onChange={(v) => onChange?.(v as V)}
            />
          </Group>
        ) : (
          label
        )
      }
      styles={{ label: hasPresets ? { width: '100%', marginBottom: 5 } : undefined }}
    >
      <Select
        {...props}
        data={selectData}
        value={value ?? null}
        onChange={(newValue) => {
          if (newValue) onChange?.(newValue as V);
        }}
        allowDeselect={false}
        disabled={disabled}
      />
    </Input.Wrapper>
  );
}
