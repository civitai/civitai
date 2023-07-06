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
import { useEffect, useRef, useState } from 'react';

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
  precision,
  sliderProps,
  numberProps,
  ...inputWrapperProps
}: NumberSliderProps) {
  const { classes, cx } = useStyles();
  const numberRef = useRef<HTMLInputElement>(null);

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
          value={value}
          onChange={onChange}
        />
        <NumberInput
          ref={numberRef}
          {...numberProps}
          className={cx(classes.number, numberProps?.className)}
          style={{
            ...numberProps?.style,
            minWidth:
              numberProps?.style?.minWidth ??
              (numberRef.current ? getComputedWidth(numberRef.current) : undefined),
          }}
          min={min}
          max={max}
          step={step}
          precision={precision}
          value={value}
          onChange={onChange}
        />
      </Group>
    </Input.Wrapper>
  );
}

const getComputedWidth = (elem: HTMLInputElement) => {
  let ch = elem.value.length;
  if (elem.value.includes('.')) ch = ch - 0.75;
  const computed = getComputedStyle(elem);
  return `calc(${ch}ch + ${computed.paddingLeft} + ${computed.paddingRight} + ${computed.borderLeftWidth} + ${computed.borderRightWidth} + 6px)`;
};

const useStyles = createStyles((theme) => ({
  fill: { flex: 1 },
  number: { flex: 0, minWidth: 60 },
}));
