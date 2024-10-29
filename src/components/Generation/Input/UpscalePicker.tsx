import { Input, SegmentedControl, Text } from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useFormContext } from 'react-hook-form';
import { createImageElement } from '~/utils/image-utils';
import { findClosestIndex } from '~/utils/number-helpers';

export function UpscalePicker({ label, sizes }: { label?: string; sizes: number[] }) {
  const widthKey = 'upscaleWidth';
  const heightKey = 'upscaleHeight';

  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const { control, watch, setValue, getValues } = useFormContext();
  const [upscaleWidth, upscaleHeight] = watch([widthKey, heightKey]);
  const options = useMemo(() => {
    if (!size) return null;
    return sizes.map((maxSize) => {
      const ratio = Math.min(maxSize / size.width, maxSize / size.height);

      return { width: size.width * ratio, height: size.height * ratio };
    });
  }, [size]);

  const [image] = watch('image');

  useEffect(() => {
    if (!image) return;
    createImageElement(image).then((elem) => {
      setSize({ height: elem.height, width: elem.width });
    });
  }, [image]);

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
    const target = upscaleWidth / upscaleHeight;
    const index = findClosestIndex(
      options.map(({ width, height }) => width / height),
      target
    );

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
          data={options.map(({ width, height }, index) => ({
            label: (
              <div className="flex flex-col items-center justify-center">
                <Text size="xs">{`${width}x${height}`}</Text>
              </div>
            ),
            value: `${index}`,
          }))}
        />
      </div>
    </>
  );
}
