import {
  Input,
  InputWrapperProps,
  CloseButton,
  Card,
  Text,
  Switch,
  Collapse,
  Paper,
} from '@mantine/core';
import { getImageData } from '~/utils/media-preprocessors';
import { trpc } from '~/utils/trpc';
import { useEffect, useState } from 'react';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { maxOrchestratorImageFileSize, isOrchestratorUrl } from '~/server/common/constants';
import { withController } from '~/libs/form/hoc/withController';
import { getBase64 } from '~/utils/file-utils';
import { SourceImageProps } from '~/server/orchestrator/infrastructure/base.schema';
import { useLocalStorage } from '@mantine/hooks';

function SourceImageUpload({
  value,
  onChange,
  ...inputWrapperProps
}: {
  value?: SourceImageProps | null;
  onChange?: (value?: SourceImageProps | null) => void;
  upscale?: boolean;
  readonly?: boolean;
} & Omit<InputWrapperProps, 'children' | 'value' | 'onChange'>) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const { mutate, isLoading } = trpc.orchestrator.imageUpload.useMutation({
    onError: (error) => {
      setError(error.message);
    },
    onSuccess: ({ blob }) => {
      // if (blob.nsfwLevel === 'na') setError('Could not evaluate. Please try another image.');
      if (blob.url) handleUrlChange(blob.url);
    },
  });

  function handleUrlChange(url: string) {
    getImageData(url).then(({ width, height }) => {
      setError(undefined);
      onChange?.({ url, width, height });
    });
  }

  function handleChange(value?: string) {
    setError(undefined);
    if (!value) onChange?.(null);
    else mutate({ sourceImage: value });
  }

  async function handleDrop(files: File[]) {
    const base64 = await getBase64(files[0]);
    handleChange(base64);
  }

  async function handleDropCapture(url: string) {
    handleChange(url);
  }

  useEffect(() => {
    if (value && typeof value === 'string' && (value as string).length > 0) handleUrlChange(value);
  }, [value]);

  return (
    <Input.Wrapper {...inputWrapperProps} error={error ?? inputWrapperProps.error}>
      {!value ? (
        <ImageDropzone
          allowExternalImageDrop
          onDrop={handleDrop}
          count={value ? 1 : 0}
          max={1}
          maxSize={maxOrchestratorImageFileSize}
          label="Drag image here or click to select a file"
          onDropCapture={handleDropCapture}
          loading={isLoading}
        />
      ) : (
        <div className="flex justify-center overflow-hidden rounded-md bg-gray-2 dark:bg-dark-6">
          <div className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={value.url}
              alt="image to refine"
              className="max-h-full shadow-sm shadow-black"
              onLoad={() => setLoaded(true)}
            />
            {loaded && (
              <CloseButton
                color="red"
                variant="filled"
                className="absolute right-0 top-0 rounded-tr-none"
                onClick={() => handleChange()}
              />
            )}
          </div>
        </div>
      )}
    </Input.Wrapper>
  );
}

export const InputSourceImageUplaod = withController(SourceImageUpload, ({ field }) => ({
  value: field.value,
}));

export function SourceImageUploadAccordion({
  value,
  onChange,
}: {
  value?: SourceImageProps | null;
  onChange?: (value?: SourceImageProps | null) => void;
}) {
  const [checked, setChecked] = useLocalStorage({ key: 'byoi', defaultValue: value !== undefined });
  const actuallyChecked = checked || !!value;

  return (
    <Card withBorder p={0}>
      <Card.Section p="xs" className="flex items-center justify-between">
        <Text weight={500}>Start from an image</Text>
        <Switch
          checked={actuallyChecked}
          onChange={(e) => {
            const checked = e.target.checked;
            setChecked(e.target.checked);
            if (!checked) onChange?.(null);
          }}
        />
      </Card.Section>
      <Collapse in={actuallyChecked}>
        <Card.Section withBorder className="border-b-0 bg-gray-2 dark:bg-dark-6">
          <SourceImageUpload value={value} onChange={onChange} />
        </Card.Section>
      </Collapse>
    </Card>
  );
}
