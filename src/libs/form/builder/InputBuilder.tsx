import { InputText, InputTextArea, InputSegmentedControl } from '~/libs/form/components';
import { InputBuilderProps } from './types';
import { Input, Paper, Text } from '@mantine/core';

export function InputBuilder(props: InputBuilderProps) {
  switch (props.type) {
    case 'text':
      return <InputText {...props} />;
    case 'textarea':
      return <InputTextArea autosize {...props} />;
    case 'aspect-ratio':
      return <></>;
  }
}

function InputAspectRatio({
  name,
  label,
  options,
}: {
  name: string;
  label: string;
  options: { label: string; width: number; height: number }[];
}) {
  return (
    <div className="flex flex-col gap-1">
      <Input.Label>{label}</Input.Label>
      <InputSegmentedControl
        name={name}
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
