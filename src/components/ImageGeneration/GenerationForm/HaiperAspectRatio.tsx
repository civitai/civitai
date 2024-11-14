import { Input, Paper, Text } from '@mantine/core';
import { InputSegmentedControl } from '~/libs/form';

const ratios = ['16:9', '9:16', '3:4', '4:3', '1:1'].reverse();
export function HaiperAspectRatio({ name, label }: { name: string; label: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <Input.Label>{label}</Input.Label>
      <InputSegmentedControl
        name={name}
        data={ratios.map((value) => {
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
