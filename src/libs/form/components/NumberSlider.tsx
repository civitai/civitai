import {
  Group,
  Input,
  InputWrapperProps,
  NumberInput,
  NumberInputProps,
  Slider,
  SliderProps,
  createStyles,
} from '@mantine/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PresetOptions, Props as PresetOptionsProps } from './PresetOptions';

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
  const { classes, cx } = useStyles();
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

  const handleInputChange = (value?: number) => {
    setState((current) => ({ ...current, value, selectedPreset: value?.toString() }));
    onChange?.(value);
  };

  const precision = useMemo(
    () => initialPrecision ?? step?.toString().split('.')[1].length,
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
          <Group spacing={8} position="apart" noWrap>
            {label}
            <PresetOptions
              disabled={disabled}
              color="blue"
              options={presets}
              value={state.selectedPreset}
              onChange={(value) => {
                setState((current) => ({ ...current, selectedPreset: value }));
                onChange?.(Number(value));
              }}
            />
          </Group>
        ) : (
          label
        )
      }
      className={cx(classes.fill, inputWrapperProps.className)}
      styles={{ label: hasPresets ? { width: '100%', marginBottom: 5 } : undefined }}
    >
      <Group spacing="xs" style={reverse ? { flexDirection: 'row-reverse' } : undefined}>
        <Slider
          {...sliderProps}
          className={cx(classes.fill, sliderProps?.className)}
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
          className={cx(classes.number, numberProps?.className)}
          style={{
            ...numberProps?.style,
            minWidth: numberProps?.style?.minWidth ?? state.computedWidth,
          }}
          min={min}
          max={max}
          step={step}
          precision={precision}
          value={state.value}
          onChange={handleInputChange}
          onBlur={handleInputBlur}
          onFocus={handleInputFocus}
          disabled={disabled}
        />
      </Group>
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

const useStyles = createStyles(() => ({
  fill: { flex: 1 },
  number: { flex: 0, minWidth: 60 },
}));
