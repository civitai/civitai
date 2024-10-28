import { Input, Paper, SegmentedControl, Text } from '@mantine/core';
import { useMemo } from 'react';

type AspectRatioValueProps = { width: number; height: number };

export type AspectRatioPickerProps = {
  label?: string;
  value?: AspectRatioValueProps;
  onChange?: (args: AspectRatioValueProps) => void;
  options: { label: string; width: number; height: number }[];
  name?: string;
};

export function AspectRatioPicker({ label, value, onChange, options }: AspectRatioPickerProps) {
  // TODO get the selected index by finding the closest matching height/width
  // there would be no internally managed state

  const selectedIndex = useMemo(() => {
    if (!value) return undefined;
    const target = value.width / value.height;
    return options
      .map(({ width, height }) => width / height)
      .reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a))
      .toString();
  }, [value]);

  function handleChange(stringIndex: string) {
    const index = Number(stringIndex);
    const match = options[index];
    if (match) onChange?.({ width: match.width, height: match.height });
  }

  // TODO - controlled input type hidden with name width
  // TODO - controlled input type hidden with name height

  return (
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
  );
}
