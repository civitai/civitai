import type { InputWrapperProps, NumberInputProps, SliderProps } from '@mantine/core';
import { Group, Input, NumberInput, Slider } from '@mantine/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import clsx from 'clsx';

// =============================================================================
// Types
// =============================================================================

interface PresetOption {
  label: string;
  value: number;
}

export interface SliderInputProps extends Omit<InputWrapperProps, 'children' | 'onChange'> {
  value?: number;
  onChange?: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  precision?: number;
  sliderProps?: Omit<SliderProps, 'value' | 'onChange' | 'min' | 'max' | 'step' | 'precision'>;
  numberProps?: Omit<NumberInputProps, 'value' | 'onChange' | 'min' | 'max' | 'step' | 'precision'>;
  reverse?: boolean;
  presets?: PresetOption[];
  disabled?: boolean;
}

// =============================================================================
// Preset Options Component
// =============================================================================

interface PresetOptionsProps {
  options: PresetOption[];
  value?: number;
  onChange: (value: number) => void;
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

type State = {
  focused: boolean;
  value?: number;
  changeEndValue?: number;
  computedWidth?: string;
};

export function SliderInput({
  value,
  onChange,
  min = 0,
  max = 100,
  step,
  precision: initialPrecision,
  sliderProps,
  numberProps,
  reverse,
  presets,
  label,
  disabled,
  ...inputWrapperProps
}: SliderInputProps) {
  const numberRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({
    focused: false,
    value,
    changeEndValue: undefined,
    computedWidth: undefined,
  });

  const handleSliderChange = (newValue?: number) => {
    setState((current) => ({ ...current, value: newValue }));
  };

  const handleInputChange = (newValue?: number | string) => {
    const parsedValue = typeof newValue === 'string' ? parseFloat(newValue) : newValue;
    setState((current) => ({ ...current, value: parsedValue }));
    onChange?.(parsedValue as any);
  };

  const precision = useMemo(
    () => initialPrecision ?? step?.toString().split('.')[1]?.length,
    [initialPrecision, step]
  );

  const handleSliderFocus = (event: React.FocusEvent<HTMLDivElement>) => {
    setState((current) => ({ ...current, focused: true }));
    sliderProps?.onFocus?.(event);
  };

  const handleSliderBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    setState((current) => ({ ...current, focused: false }));
    sliderProps?.onBlur?.(event);
  };

  const handleInputFocus = (event: React.FocusEvent<HTMLInputElement>) => {
    setState((current) => ({ ...current, focused: true }));
    numberProps?.onFocus?.(event);
  };

  const handleInputBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    setState((current) => ({ ...current, focused: false }));
    numberProps?.onBlur?.(event);
  };

  useEffect(() => {
    if (!state.focused) setState((current) => ({ ...current, value }));
  }, [value, precision, state.focused]);

  useEffect(() => {
    if (state.changeEndValue === undefined) return;
    onChange?.(state.changeEndValue);
    // Clear changeEndValue after calling onChange to prevent re-firing on onChange reference change
    setState((current) => ({ ...current, changeEndValue: undefined }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.changeEndValue]);

  useEffect(() => {
    if (!numberRef.current) return;
    setState((current) => ({
      ...current,
      computedWidth: numberRef.current
        ? getComputedWidth(numberRef.current, min, max, precision)
        : undefined,
    }));
  }, [min, max, precision]);

  const hasPresets = presets && presets.length > 0;

  return (
    <Input.Wrapper
      {...inputWrapperProps}
      label={
        hasPresets ? (
          <Group gap={8} className="w-full" justify="space-between" wrap="nowrap">
            {label}
            <PresetOptions
              disabled={disabled}
              options={presets}
              value={value}
              onChange={(v) => onChange?.(v)}
            />
          </Group>
        ) : (
          label
        )
      }
      className={clsx('flex flex-col', inputWrapperProps.className)}
      classNames={{ label: !presets?.length ? '-mb-3' : undefined }}
      styles={{ label: hasPresets ? { width: '100%', marginBottom: 5 } : undefined }}
    >
      <div className={clsx('mt-1 flex items-center gap-2', { ['flex-row-reverse']: reverse })}>
        <Slider
          {...sliderProps}
          className={clsx('flex-1', sliderProps?.className)}
          min={min}
          max={max}
          step={step}
          precision={precision}
          value={state.value}
          onChange={handleSliderChange}
          onBlur={handleSliderBlur}
          onFocus={handleSliderFocus}
          label={(v) => (v && precision ? v.toFixed(precision) : v)}
          onChangeEnd={(v) => setState((current) => ({ ...current, changeEndValue: v }))}
          disabled={disabled}
        />
        <NumberInput
          ref={numberRef}
          {...numberProps}
          className={clsx('min-w-[60px] flex-[0]', numberProps?.className)}
          style={{
            ...numberProps?.style,
            minWidth: (numberProps?.style as CSSProperties)?.minWidth ?? state.computedWidth,
          }}
          min={min}
          max={max}
          step={step}
          decimalScale={precision}
          value={state.value}
          onChange={handleInputChange}
          onBlur={handleInputBlur}
          onFocus={handleInputFocus}
          disabled={disabled}
        />
      </div>
    </Input.Wrapper>
  );
}

// =============================================================================
// Helpers
// =============================================================================

const getComputedWidth = (elem: HTMLInputElement, min: number, max: number, precision?: number) => {
  const stringValue = [min, max]
    .map((x) => (precision ? x.toFixed(precision) : x.toString()))
    .sort((a, b) => b.length - a.length)[0];
  let ch = stringValue.length;
  if (stringValue.includes('.')) ch = ch - 0.75;
  const computed = getComputedStyle(elem);
  return `calc(${ch}ch + ${computed.paddingLeft} + ${computed.paddingRight} + ${computed.borderLeftWidth} + ${computed.borderRightWidth} + 6px)`;
};
