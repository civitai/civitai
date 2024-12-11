import { CloseButton, Input, InputWrapperProps } from '@mantine/core';
import { useEffect } from 'react';
import { useFormContext } from 'react-hook-form';
import { TwCard } from '~/components/TwCard/TwCard';
import { withController } from '~/libs/form/hoc/withController';
import { generationFormStore, useGenerationFormStore } from '~/store/generation.store';
import { getImageData } from '~/utils/media-preprocessors';

export function ImageUrlInput({
  value,
  onChange,
  ...inputWrapperProps
}: {
  value?: string;
  onChange?: (value?: string) => void;
} & Omit<InputWrapperProps, 'children' | 'onChange'>) {
  // const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    if (value)
      getImageData(value).then(({ width, height }) => {
        useGenerationFormStore.setState({ width, height });
      });
    else {
      useGenerationFormStore.setState({ width: undefined, height: undefined });
    }
  }, [value]);

  if (!value) return <></>;

  return (
    <Input.Wrapper {...inputWrapperProps}>
      <div className="relative inline-block">
        <input type="hidden" value={value} className="hidden" />

        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={value}
          alt="image to refine"
          className="max-w-40 rounded-md shadow-sm shadow-black"
        />
        <CloseButton
          color="red"
          variant="filled"
          className="absolute right-0 top-0"
          onClick={() => onChange?.()}
        />
      </div>
    </Input.Wrapper>
  );
}
