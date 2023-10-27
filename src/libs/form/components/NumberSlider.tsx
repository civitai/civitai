import {
  Input,
  InputWrapperProps,
  Group,
  Slider,
  NumberInput,
  SliderProps,
  NumberInputProps,
  createStyles,
} from '@mantine/core';
import { useEffect, useMemo, useRef, useState } from 'react';

export type NumberSliderProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: number;
  onChange?: (value?: number) => void;
  min: number;
  max: number;
  step?: number;
  precision?: number;
  sliderProps?: Omit<SliderProps, 'value' | 'onChange' | 'min' | 'max' | 'step' | 'precision'>;
  numberProps?: Omit<NumberInputProps, 'value' | 'onChange' | 'min' | 'max' | 'step' | 'precision'>;
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
  ...inputWrapperProps
}: NumberSliderProps) {
  const { classes, cx } = useStyles();
  const numberRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [_value, setValue] = useState(value);
  const [changeEndValue, setChangeEndValue] = useState<number>();
  const [computedWidth, setComputedWidth] = useState<string>();

  const handleSliderChange = (value?: number) => {
    setValue(value);
  };

  const handleInputChange = (value?: number) => {
    setValue(value);
    onChange?.(value);
  };

  const precision = useMemo(
    () => initialPrecision ?? step?.toString().split('.')[1].length,
    [initialPrecision, step]
  );

  const handleSliderFocus = (event: React.FocusEvent<HTMLDivElement>) => {
    setFocused(true);
    sliderProps?.onFocus?.(event);
  };

  const handleSliderBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    setFocused(false);
    sliderProps?.onBlur?.(event);
  };

  const handleInputFocus = (event: React.FocusEvent<HTMLInputElement>) => {
    setFocused(true);
    numberProps?.onFocus?.(event);
  };

  const handleInputBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    setFocused(false);
    numberProps?.onBlur?.(event);
  };

  useEffect(() => {
    if (!focused) {
      setValue(value);
    }
  }, [value, precision]);

  useEffect(() => {
    if (!changeEndValue) return;
    onChange?.(changeEndValue);
  }, [changeEndValue]);

  useEffect(() => {
    if (!numberRef.current) return;
    setComputedWidth(getComputedWidth(numberRef.current, min, max, precision));
  }, [min, max, precision]);

  return (
    <Input.Wrapper {...inputWrapperProps} className={cx(classes.fill, inputWrapperProps.className)}>
      <Group spacing="xs">
        <Slider
          {...sliderProps}
          className={cx(classes.fill, sliderProps?.className)}
          min={min}
          max={max}
          step={step}
          precision={precision}
          value={_value}
          onChange={handleSliderChange}
          onBlur={handleSliderBlur}
          onFocus={handleSliderFocus}
          label={(value) => (value && precision ? value.toFixed(precision) : value)}
          onChangeEnd={setChangeEndValue}
        />
        <NumberInput
          ref={numberRef}
          {...numberProps}
          className={cx(classes.number, numberProps?.className)}
          style={{
            ...numberProps?.style,
            minWidth: numberProps?.style?.minWidth ?? computedWidth,
          }}
          min={min}
          max={max}
          step={step}
          precision={precision}
          value={_value}
          onChange={handleInputChange}
          onBlur={handleInputBlur}
          onFocus={handleInputFocus}
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

const useStyles = createStyles((theme) => ({
  fill: { flex: 1 },
  number: { flex: 0, minWidth: 60 },
}));
