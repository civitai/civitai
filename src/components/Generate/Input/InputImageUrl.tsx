import { Input, InputWrapperProps } from '@mantine/core';
import { useEffect } from 'react';
import { useFormContext } from 'react-hook-form';
import { withController } from '~/libs/form/hoc/withController';
import { getImageData } from '~/utils/media-preprocessors';

function ImageUrlInput({
  value,
  onChange,
  ...inputWrapperProps
}: {
  value?: string;
  onChange?: (value?: string) => void;
} & Omit<InputWrapperProps, 'children'>) {
  // const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const { setValue } = useFormContext();

  useEffect(() => {
    if (value)
      getImageData(value).then(({ width, height }) => {
        setValue('width', width);
        setValue('height', height);
      });
    else {
      setValue('width', undefined);
      setValue('height', undefined);
    }
  }, [value]);

  if (!value) return <></>;

  return (
    <Input.Wrapper {...inputWrapperProps}>
      <input type="hidden" value={value} className="hidden" />
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
