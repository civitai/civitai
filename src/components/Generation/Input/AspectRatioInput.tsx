import {
  Autocomplete,
  Card,
  NumberInput,
  Paper,
  SegmentedControl,
  Slider,
  Text,
  TextInput,
} from '@mantine/core';
import { useEffect, useMemo, useState } from 'react';
import { TwCard } from '~/components/TwCard/TwCard';
import { InputNumber } from '~/libs/form';
import { getRoundedWidthHeight } from '~/shared/constants/generation.constants';
import { getRatio } from '~/utils/number-helpers';
import { titleCase } from '~/utils/string-helpers';

type AspectRatioValue = { width: number; height: number };

export function AspectRatio({
  value,
  onChange,
}: {
  value?: AspectRatioValue;
  onChange?: (value: AspectRatioValue) => void;
}) {
  const ratio = 2 / 3;

  const [size, setSize] = useState({ width: 512, height: 512 });
  const [resolution, setResolution] = useState(512);
  const [orientation, setOrientation] = useState(
    Object.entries(aspectRatioConfig).find(([key, { checker }]) => checker(ratio))![0]
  );

  const options = aspectRatioConfig[orientation as keyof typeof aspectRatioConfig];

  function handleSelectRatio(ratio: string) {
    const [rw, rh] = ratio.split(':').map(Number);
    if (orientation === 'landscape') {
      const ratio = resolution / rw;
      const height = ratio * rh;
      // const size = getRoundedWidthHeight({width: resolution, height})
      setSize(getRoundedWidthHeight({ width: resolution, height }));
    }
  }

  return (
    <div>
      <div className="mb-0.5 flex items-end justify-between">
        <label>Aspect Ratio</label>
        <SegmentedControl
          data={aspectRatioOrientations}
          value={orientation}
          onChange={setOrientation}
          size="xs"
          transitionDuration={0}
        />
      </div>
      <SegmentedControl
        className="w-full"
        transitionDuration={0}
        onChange={handleSelectRatio}
        data={options.ratios.map((ratio) => {
          const [rw, rh] = ratio.split(':').map(Number);
          return {
            value: ratio,
            label: (
              <div className="flex flex-col items-center justify-center gap-0.5">
                <Paper withBorder className="h-7 border-2" style={{ aspectRatio: rw / rh }} />
                <Text size="xs">{ratio}</Text>
              </div>
            ),
          };
        })}
      />
      {/* <span>Resolution</span> */}
      {/* <Slider
        min={resolutionConfig.min}
        max={resolutionConfig.max}
        value={resolution}
        onChange={setResolution}
        className="w-full"
        step={64}
      /> */}
    </div>
  );
}

const aspectRatioConfig = {
  portrait: {
    checker: (ratio: number) => ratio <= 1,
    ratios: ['1:1', '2:3', '9:16'],
  },
  landscape: {
    checker: (ratio: number) => ratio > 1,
    ratios: ['1:1', '3:2', '16:9'],
  },
};

const aspectRatioOrientations = Object.keys(aspectRatioConfig).map((orientation) => ({
  label: titleCase(orientation),
  value: orientation,
}));

const resolutionConfig = {
  min: 512,
  max: 1024,
};

export function CustomAspectRatio({
  minResolution,
  maxResolution,
  defaultResolution,
}: {
  minResolution: number;
  maxResolution: number;
  defaultResolution: number;
}) {
  // const [aspectRatio, setAspectRatio] = useState<string>();
  // const [resolution, setResolution] = useState(defaultResolution);
  const [size, setSize] = useState<{ width?: number; height?: number }>();

  // function handleAspectRatioChange(value: string) {
  //   const validated = value.replace(/[^\d|:]/g, '').replace(/(\d+:\d+)(.+)/g, '$1');
  //   setAspectRatio(validated);
  // }

  // useEffect(() => {
  //   if (aspectRatio) setSize(getSize(aspectRatio, resolution));
  // }, [aspectRatio, resolution]);

  return (
    <div className="flex flex-col gap-3">
      {/* <div className="flex gap-3">
        <div className="flex-1">
          <span>Resolution</span>
          <Slider
            min={minResolution}
            max={maxResolution}
            value={resolution}
            onChange={setResolution}
            className="w-full"
            step={64}
          />
        </div>
        <Autocomplete
          label="Aspect Ratio"
          placeholder="3:2"
          data={['16:9', '3:2', '1:1', '2:3', '9:16']}
          onChange={handleAspectRatioChange}
          value={aspectRatio}
        />
      </div> */}

      <div className="flex w-1/2 flex-col gap-2">
        <div className="grid grid-cols-2 gap-2">
          <NumberInput
            label="Width"
            min={minResolution}
            max={maxResolution}
            step={64}
            value={size?.width}
            allowDecimal={false}
            onChange={(width) => setSize((size) => ({ ...size, width: Number(width) }))}
          />
          <NumberInput
            label="height"
            min={minResolution}
            max={maxResolution}
            step={64}
            value={size?.height}
            allowDecimal={false}
            onChange={(height) => setSize((size) => ({ ...size, height: Number(height) }))}
          />
        </div>
        <div className="grid grid-cols-[min-content,min-content,auto] gap-2">
          {size?.width && size.height && (
            <AspectRatioCard
              width={size.width}
              height={size.height}
              min={minResolution}
              max={maxResolution}
            />
          )}
        </div>
      </div>
      <div className="mb-2 grid grid-cols-2 gap-2">
        <div className="grid grid-cols-[min-content,min-content,auto] gap-2">
          <AspectRatioCard width={512} height={1024} min={minResolution} max={maxResolution} />
          <AspectRatioCard width={768} height={1024} min={minResolution} max={maxResolution} />
        </div>
        <div className="grid grid-cols-[min-content,min-content,auto] gap-2">
          <AspectRatioCard width={1024} height={1024} min={minResolution} max={maxResolution} />
          <AspectRatioCard width={1024} height={768} min={minResolution} max={maxResolution} />
        </div>
      </div>
    </div>
  );
}

function AspectRatioCard({
  width,
  height,
  min,
  max,
}: {
  width: number;
  height: number;
  min: number;
  max: number;
}) {
  const rounded = getRoundedWidthHeight({ width, height });
  const ratio = getRatio(rounded.width, rounded.height);
  const [rw, rh] = ratio.split(':').map(Number);

  if (width < min || height < min) return null;

  return (
    <Card withBorder className="col-span-3 grid grid-cols-subgrid items-center gap-2 p-2">
      <div className="flex justify-center">
        <Paper withBorder className="h-8  border-2" style={{ aspectRatio: rw / rh }}></Paper>
      </div>
      <Text className="font-semibold">{ratio}</Text>
      <Text size="sm" color="dimmed">
        {rounded.width}x{rounded.height}
      </Text>
    </Card>
  );
}

function getSize(aspectRatio: string, resolution: number) {
  const regex = new RegExp(/(\d+:\d+)/g);
  const validated = regex.test(aspectRatio);
  if (!validated) return;
  const [rw, rh] = aspectRatio.split(':').map(Number);
  if (rw > rh) {
    const ratio = resolution / rw;
    const height = ratio * rh;
    return getRoundedWidthHeight({ width: resolution, height });
  } else {
    const ratio = resolution / rh;
    const width = ratio * rw;
    return getRoundedWidthHeight({ width, height: resolution });
  }
}
