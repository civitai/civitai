import { Input, Paper, SegmentedControl, Text } from '@mantine/core';
import { useEffect, useMemo } from 'react';
import { Controller, useFormContext } from 'react-hook-form';
import { findClosestIndex } from '~/utils/number-helpers';

export type AspectRatioPickerProps = {
  label?: string;
  options: { label: string; width: number; height: number }[];
};

export function AspectRatioPicker({ label, options }: AspectRatioPickerProps) {
  const widthKey = 'width';
  const heightKey = 'height';

  const { control, watch, setValue, getValues } = useFormContext();
  const [width, height] = watch([widthKey, heightKey]);

  useEffect(() => {
    const [width, height] = getValues([widthKey, heightKey]);
    if (!width || !height) {
      setValue(widthKey, options[0].width);
      setValue(heightKey, options[0].height);
    }
  }, []);

  const selectedIndex = useMemo(() => {
    if (!width || !height) return undefined;
    const target = width / height;
    const index = findClosestIndex(
      options.map(({ width, height }) => width / height),
      target
    );

    return index.toString();
  }, [width, height]);

  function handleChange(stringIndex: string) {
    const index = Number(stringIndex);
    const match = options[index];
    if (match) {
      setValue(widthKey, match.width);
      setValue(heightKey, match.height);
    }
  }

  return (
    <>
      <Controller
        name={widthKey}
        control={control}
        render={({ field: { value } }) => <input type="hidden" value={value ?? ''} />}
      />
      <Controller
        name={heightKey}
        control={control}
        render={({ field: { value } }) => <input type="hidden" value={value ?? ''} />}
      />
      <div className="flex flex-col gap-1">
        <Input.Label>{label}</Input.Label>
        <SegmentedControl
          value={selectedIndex}
          onChange={handleChange}
          data={options.map(({ label, width, height }, index) => ({
            label: (
              <div className="flex flex-col items-center justify-center gap-0.5">
                <Paper
                  withBorder
                  style={{ borderWidth: 2, aspectRatio: `${width}/${height}`, height: 20 }}
                />
                <div className="flex flex-col items-center justify-center">
                  <Text size="xs">{label}</Text>
                  <Text size={10} color="dimmed">{`${width}x${height}`}</Text>
                </div>
              </div>
            ),
            value: `${index}`,
          }))}
        />
      </div>
    </>
  );
}
