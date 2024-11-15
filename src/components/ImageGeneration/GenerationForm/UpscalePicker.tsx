import { Input, SegmentedControl, Text } from '@mantine/core';
import { useEffect, useMemo } from 'react';
import { Controller, useFormContext } from 'react-hook-form';
import { getRoundedUpscaleSize } from '~/shared/constants/generation.constants';

const multipliers = [1.5, 2, 2.5, 3];

export function UpscalePicker({
  label,
  width,
  height,
}: {
  label?: string;
  width: number;
  height: number;
}) {
  const widthKey = 'upscaleWidth';
  const heightKey = 'upscaleHeight';

  const { control, watch, setValue, getValues } = useFormContext();

  const [upscaleWidth, upscaleHeight] = watch([widthKey, heightKey]);
  const options = useMemo(() => {
    if (!width || !height) return null;

    const sizes = multipliers.map((multiplier) => ({
      multiplier,
      ...getRoundedUpscaleSize({ width: multiplier * width, height: multiplier * height }),
    }));
    return sizes;
  }, [width, height]);

  useEffect(() => {
    if (!options) return;
    const [upscaleWidth, upscaleHeight] = getValues([widthKey, heightKey]);
    if (!upscaleWidth || !upscaleHeight) {
      setValue(widthKey, options[0].width);
      setValue(heightKey, options[0].height);
    }
  }, [options]);

  const selectedIndex = useMemo(() => {
    if (!upscaleWidth || !upscaleHeight || !options) return undefined;
    const index = options.findIndex((x) => x.width === upscaleWidth && x.height === upscaleHeight);
    return index.toString();
  }, [upscaleWidth, upscaleHeight, options]);

  function handleChange(stringIndex: string) {
    if (options) {
      const index = Number(stringIndex);
      const match = options[index];
      if (match) {
        setValue(widthKey, match.width);
        setValue(heightKey, match.height);
      }
    }
  }

  if (!options) return null;

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
          transitionDuration={0}
          data={options.map(({ multiplier }, index) => ({
            label: (
              <div className="flex flex-col items-center justify-center">
                <Text size="xs">{multiplier}</Text>
              </div>
            ),
            value: `${index}`,
          }))}
        />
        <Text color="dimmed" align="center">
          Upscale dimensions: {upscaleWidth} x {upscaleHeight}
        </Text>
      </div>
    </>
  );
}
