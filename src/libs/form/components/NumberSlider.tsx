import type { InputWrapperProps, NumberInputProps, SliderProps } from '@mantine/core';
import { Group, Input, NumberInput, Slider } from '@mantine/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { Props as PresetOptionsProps } from './PresetOptions';
import { PresetOptions } from './PresetOptions';
import clsx from 'clsx';

export type NumberSliderProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: number;
  onChange?: (value?: number) => void;
  min: number;
  max: number;
  step?: number;
  precision?: number;
  sliderProps?: Omit<SliderProps, 'value' | 'onChange' | 'min' | 'max' | 'step' | 'precision'>;
  numberProps?: Omit<NumberInputProps, 'value' | 'onChange' | 'min' | 'max' | 'step' | 'precision'>;
  reverse?: boolean;
  presets?: PresetOptionsProps['options'];
  disabled?: boolean;
};

type State = {
  focused: boolean;
  value?: number;
  changeEndValue?: number;
  computedWidth?: string;
  selectedPreset?: string;
};

export function NumberSlider({
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
}: NumberSliderProps) {
  const numberRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<State>({
    focused: false,
    value,
    changeEndValue: undefined,
    computedWidth: undefined,
    selectedPreset: value?.toString(),
  });

  const handleSliderChange = (value?: number) => {
    setState((current) => ({ ...current, value, selectedPreset: value?.toString() }));
  };

  const handleInputChange = (value?: number | string) => {
    const parsedValue = typeof value === 'string' ? parseFloat(value) : value;
    setState((current) => ({
      ...current,
      value: parsedValue,
      selectedPreset: parsedValue?.toString(),
    }));
    onChange?.(parsedValue);
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
    // Set the right selectedPreset when value changes
    if (value?.toString() !== state.selectedPreset)
      setState((current) => ({ ...current, selectedPreset: value?.toString() }));
  }, [state.selectedPreset, value]);

  useEffect(() => {
    if (!state.changeEndValue) return;
    onChange?.(state.changeEndValue);
  }, [state.changeEndValue]);

  useEffect(() => {
    if (!numberRef.current) return;
    setState((current) => ({
      ...current,
      // Just to keep ts happy :shrug:
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
              value={value?.toString()}
              onChange={(value) => {
                setState((current) => ({ ...current, selectedPreset: value }));
                onChange?.(Number(value));
              }}
              chipPropsOverrides={{ color: 'blue' }}
            />
          </Group>
        ) : (
          label
        )
      }
      className={clsx('flex flex-col', inputWrapperProps.className)}
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
          label={(value) => (value && precision ? value.toFixed(precision) : value)}
          onChangeEnd={(value) => setState((current) => ({ ...current, changeEndValue: value }))}
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

const getComputedWidth = (elem: HTMLInputElement, min: number, max: number, precision?: number) => {
  const stringValue = [min, max]
    .map((x) => (precision ? x.toFixed(precision) : x.toString()))
    .sort((a, b) => b.length - a.length)[0];
  let ch = stringValue.length;
  if (stringValue.includes('.')) ch = ch - 0.75;
  const computed = getComputedStyle(elem);
  return `calc(${ch}ch + ${computed.paddingLeft} + ${computed.paddingRight} + ${computed.borderLeftWidth} + ${computed.borderRightWidth} + 6px)`;
};
