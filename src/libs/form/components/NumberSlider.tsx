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

export type NumberSliderProps = Omit<InputWrapperProps, 'children'> & {
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
  min,
  max,
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

  const handleChange = (value?: number) => {
    if (value !== _value) {
      setValue(value);
      onChange?.(value);
    }
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
      console.log({ value: numberRef.current?.value });
      setValue(value);
    }
  }, [value, precision]);

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
          onChange={handleChange}
          onBlur={handleSliderBlur}
          onFocus={handleSliderFocus}
        />
        <NumberInput
          ref={numberRef}
          {...numberProps}
          className={cx(classes.number, numberProps?.className)}
          style={{
            ...numberProps?.style,
            minWidth:
              numberProps?.style?.minWidth ??
              (numberRef.current
                ? getComputedWidth(numberRef.current, _value, precision)
                : undefined),
          }}
          min={min}
          max={max}
          step={step}
          precision={precision}
          value={_value}
          onChange={handleChange}
          onBlur={handleInputBlur}
          onFocus={handleInputFocus}
        />
      </Group>
    </Input.Wrapper>
  );
}

const getComputedWidth = (elem: HTMLInputElement, value?: number, precision?: number) => {
  if (!value) return;
  const stringValue = (precision ? value.toFixed(precision) : value).toString();
  let ch = stringValue.length;
  if (stringValue.includes('.')) ch = ch - 0.75;
  const computed = getComputedStyle(elem);
  return `calc(${ch}ch + ${computed.paddingLeft} + ${computed.paddingRight} + ${computed.borderLeftWidth} + ${computed.borderRightWidth} + 6px)`;
};

const useStyles = createStyles((theme) => ({
  fill: { flex: 1 },
  number: { flex: 0, minWidth: 60 },
}));
