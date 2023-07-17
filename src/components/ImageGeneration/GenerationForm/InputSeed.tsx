import { usePrevious } from '@dnd-kit/utilities';
import { Group, Input, InputWrapperProps, SegmentedControl } from '@mantine/core';
import { useEffect, useState } from 'react';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { withController } from '~/libs/form/hoc/withController';

type Props = {
  value?: number;
  onChange?: (value?: number) => void;
  min: number;
  max: number;
} & Omit<InputWrapperProps, 'children'>;

function SeedInput({ value, onChange, min, max, ...inputWrapperProps }: Props) {
  const [control, setControl] = useState(value ? 'custom' : 'random');

  const previousControl = usePrevious(control);
  useEffect(() => {
    if (value === undefined && previousControl !== 'random') setControl('random');
    else if (value !== undefined && previousControl !== 'custom') setControl('custom');
  }, [value]); //eslint-disable-line

  useEffect(() => {
    if (value !== undefined && control === 'random') onChange?.(undefined);
    else if (value === undefined && control === 'custom')
      onChange?.(Math.floor(Math.random() * max));
  }, [control]); //eslint-disable-line

  return (
    <Input.Wrapper {...inputWrapperProps}>
      <Group>
        <SegmentedControl
          value={control}
          onChange={setControl}
          data={[
            { label: 'Random', value: 'random' },
            { label: 'Custom', value: 'custom' },
          ]}
        />
        <NumberInputWrapper
          value={value}
          onChange={onChange}
          placeholder="Random"
          clearable
          min={min}
          max={max}
          sx={{ flex: 1 }}
          hideControls
          format="default"
        />
      </Group>
    </Input.Wrapper>
  );
}

const InputSeed = withController(SeedInput, ({ field }) => ({
  value: field.value,
}));
export default InputSeed;
