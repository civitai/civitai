import { Paper, SegmentedControl, Text } from '@mantine/core';

export function AspectRatioSelector({
  value,
  onChange,
  aspectRatios,
}: {
  value: string;
  onChange: (value: string) => void;
  aspectRatios: { label: string; width: number; height: number }[];
}) {
  return (
    <div className="flex flex-col gap-1">
      <Text size="sm" fw={500}>
        Aspect Ratio
      </Text>
      <SegmentedControl
        value={value}
        onChange={onChange}
        data={aspectRatios.map(({ label, width, height }) => ({
          label: (
            <div className="flex flex-col items-center gap-1">
              <Paper
                withBorder
                style={{ borderWidth: 2, aspectRatio: `${width}/${height}`, height: 20 }}
              />
              <Text size="xs">{label}</Text>
            </div>
          ),
          value: label,
        }))}
      />
    </div>
  );
}
