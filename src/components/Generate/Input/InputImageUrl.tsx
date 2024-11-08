import { ActionIcon, Input, InputWrapperProps, TextInput } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import { withController } from '~/libs/form/hoc/withController';

function ImageUrlInput({
  value,
  onChange,
  ...inputWrapperProps
}: {
  value?: string;
  onChange?: (value: string | null) => void;
} & Omit<InputWrapperProps, 'children'>) {
  if (!value) return <></>;
  return (
    <Input.Wrapper {...inputWrapperProps}>
      <input type="hidden" value={value} />
      <div>
        <div className="relative inline-block">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={value}
            alt="image to refine"
            className="max-w-40 rounded-md shadow-sm shadow-black"
          />
          <ActionIcon
            variant="light"
            size="sm"
            color="red"
            radius="xl"
            className="absolute -right-2 -top-2"
            onClick={() => onChange?.(null)}
          >
            <IconX size={16} strokeWidth={2.5} />
          </ActionIcon>
        </div>
      </div>
    </Input.Wrapper>
  );
}

export const InputImageUrl = withController(ImageUrlInput);
