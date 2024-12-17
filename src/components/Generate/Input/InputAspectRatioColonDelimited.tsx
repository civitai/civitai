import { Input, Paper, Text } from '@mantine/core';
import { InputSegmentedControl } from '~/libs/form';

export function InputAspectRatioColonDelimited({
  name,
  label,
  options,
}: {
  name: string;
  label: string;
  options: string[] | readonly string[];
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <Input.Label>{label}</Input.Label>
      <InputSegmentedControl
        name={name}
        data={options.map((value) => {
          const [width, height] = value.split(':').map(Number);
          return {
            label: (
              <div className="flex flex-col items-center justify-center gap-1">
                <Paper
                  withBorder
                  style={{ borderWidth: 2, aspectRatio: `${width}/${height}`, height: 20 }}
                />
                <Text size="xs">{value}</Text>
              </div>
            ),
            value,
          };
        })}
      />
    </div>
  );
}
