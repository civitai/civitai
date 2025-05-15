import { usePrevious } from '@dnd-kit/utilities';
import { Group, Input, InputWrapperProps, SegmentedControl } from '@mantine/core';
import { useEffect, useState } from 'react';
import { NumberInputWrapper } from '~/libs/form/components/NumberInputWrapper';
import { withController } from '~/libs/form/hoc/withController';
import { generation, maxRandomSeed } from '~/server/common/constants';

type Props = {
  value?: number;
  onChange?: (value?: number) => void;

  disabled?: boolean;
} & Omit<InputWrapperProps, 'children'>;

function SeedInput({ value, onChange, disabled, ...inputWrapperProps }: Props) {
  const [control, setControl] = useState(value ? 'custom' : 'random');

  const previousControl = usePrevious(control);
  useEffect(() => {
    if (value === undefined && previousControl !== 'random') setControl('random');
    else if (value !== undefined && previousControl !== 'custom') setControl('custom');
  }, [value]); //eslint-disable-line

  useEffect(() => {
    if (value !== undefined && control === 'random') onChange?.(undefined);
    else if (value === undefined && control === 'custom')
      onChange?.(Math.floor(Math.random() * maxRandomSeed));
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
          disabled={disabled}
        />
        <NumberInputWrapper
          value={value}
          onChange={onChange ? (v) => onChange(v ? Number(v) : undefined) : undefined}
          placeholder="Random"
          clearable
          min={1}
          max={generation.maxValues.seed}
          style={{ flex: 1 }}
          hideControls
          format="default"
          disabled={disabled}
        />
      </Group>
    </Input.Wrapper>
  );
}

const InputSeed = withController(SeedInput, ({ field }) => ({
  value: field.value,
}));
export default InputSeed;
