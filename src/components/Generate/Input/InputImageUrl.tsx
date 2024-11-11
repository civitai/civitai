import { ActionIcon, Input, InputWrapperProps } from '@mantine/core';
import { IconX } from '@tabler/icons-react';
import { withController } from '~/libs/form/hoc/withController';

function ImageUrlInput({
  value,
  onChange,
  ...inputWrapperProps
}: {
  value?: string;
  onChange?: (value?: string) => void;
} & Omit<InputWrapperProps, 'children'>) {
  if (!value) return <></>;
  return (
    <Input.Wrapper {...inputWrapperProps}>
      <input type="hidden" value={value} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={value}
        alt="image to refine"
        className="max-w-40 rounded-md shadow-sm shadow-black"
      />
    </Input.Wrapper>
  );
}

export const InputImageUrl = withController(ImageUrlInput);
