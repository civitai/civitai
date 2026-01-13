import type { InputWrapperProps } from '@mantine/core';
import { Group, Input, NumberInput, SegmentedControl } from '@mantine/core';
import { useEffect, useRef } from 'react';
import { MAX_SEED, MAX_RANDOM_SEED } from '~/shared/constants/generation.constants';

// =============================================================================
// Types
// =============================================================================

export interface SeedInputProps extends Omit<InputWrapperProps, 'children' | 'onChange'> {
  value?: number;
  onChange?: (value?: number) => void;
  disabled?: boolean;
}

// =============================================================================
// Component
// =============================================================================

export function SeedInput({ value, onChange, disabled, ...inputWrapperProps }: SeedInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Derive control state from value - undefined means random
  const control = value != null ? 'custom' : 'random';

  // Force clear the input when value becomes undefined
  // Mantine NumberInput doesn't always sync internal state with controlled value
  useEffect(() => {
    if (value == null && inputRef.current && inputRef.current.value !== '') {
      inputRef.current.value = '';
    }
  }, [value]);

  const handleControlChange = (newControl: string) => {
    if (newControl === 'random') {
      onChange?.(undefined);
    } else if (newControl === 'custom') {
      // Generate a random seed when switching to custom
      onChange?.(Math.floor(Math.random() * MAX_RANDOM_SEED));
    }
  };

  const handleValueChange = (newValue: number | string) => {
    // Empty string means cleared
    if (newValue === '') {
      onChange?.(undefined);
      return;
    }

    // Parse if string (can happen with paste of large numbers)
    const numValue = typeof newValue === 'string' ? parseInt(newValue, 10) : newValue;

    // Invalid number
    if (isNaN(numValue)) {
      onChange?.(undefined);
      return;
    }

    // Clamp to max if pasted value exceeds limit
    onChange?.(Math.min(Math.max(0, numValue), MAX_SEED));
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pastedText = e.clipboardData.getData('text');
    const parsed = parseInt(pastedText.replace(/[^0-9]/g, ''), 10);

    if (!isNaN(parsed)) {
      e.preventDefault();
      onChange?.(Math.min(Math.max(0, parsed), MAX_SEED));
    }
  };

  return (
    <Input.Wrapper {...inputWrapperProps}>
      <Group>
        <SegmentedControl
          value={control}
          onChange={handleControlChange}
          data={[
            { label: 'Random', value: 'random' },
            { label: 'Custom', value: 'custom' },
          ]}
          disabled={disabled}
        />
        <NumberInput
          ref={inputRef}
          value={value}
          onChange={handleValueChange}
          onPaste={handlePaste}
          placeholder="Random"
          min={0}
          allowNegative={false}
          allowDecimal={false}
          style={{ flex: 1 }}
          hideControls
          disabled={disabled}
          className="flex-1"
        />
      </Group>
    </Input.Wrapper>
  );
}
