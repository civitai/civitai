import { Input, InputWrapperProps, CloseButton, ActionIcon } from '@mantine/core';
import { getImageData } from '~/utils/media-preprocessors';
import { trpc } from '~/utils/trpc';
import { useEffect, useState } from 'react';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { maxOrchestratorImageFileSize, maxUpscaleSize } from '~/server/common/constants';
import { withController } from '~/libs/form/hoc/withController';
import { getBase64 } from '~/utils/file-utils';
import { SourceImageProps } from '~/server/orchestrator/infrastructure/base.schema';
import { useLocalStorage } from '@mantine/hooks';

import clsx from 'clsx';
import { resizeImage } from '~/utils/image-utils';
import { IconHistory } from '@tabler/icons-react';
import { uniqBy } from 'lodash-es';

const key = 'img-uploads';
export type SourceImageUploadProps = {
  value?: SourceImageProps | null;
  onChange?: (value?: SourceImageProps | null) => void;
  removable?: boolean;
  children?: React.ReactNode;
  iconSize?: number;
} & Omit<InputWrapperProps, 'children' | 'value' | 'onChange'>;
export function SourceImageUpload({
  value,
  onChange,
  removable = true,
  className = 'min-h-36',
  label,
  children,
  iconSize,
  ...inputWrapperProps
}: SourceImageUploadProps) {
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const { mutate, isLoading, isError } = trpc.orchestrator.imageUpload.useMutation({
    onSettled: () => {
      setLoading(false);
    },
    onError: (error) => {
      setError(error.message);
      setLoading(false);
    },
    onSuccess: ({ blob }) => {
      if (blob.url) handleUrlChange(blob.url);
      setLoading(false);
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

  async function handleResizeToBase64(src: File | Blob | string) {
    setLoading(true);
    const resized = await resizeImage(src, {
      maxHeight: maxUpscaleSize,
      maxWidth: maxUpscaleSize,
    });
    return await getBase64(resized);
  }

  async function handleDrop(files: File[]) {
    const base64 = await handleResizeToBase64(files[0]);
    handleChange(base64);
  }

  async function handleDropCapture(src: File | Blob | string) {
    const base64 = await handleResizeToBase64(src);
    handleChange(base64);
  }

  useEffect(() => {
    if (value && typeof value === 'string' && (value as string).length > 0) handleUrlChange(value);
    else if (value && value instanceof Blob) handleDropCapture(value);
  }, [value]);

  const _value = value instanceof Blob ? null : value;

  function getHistory() {
    const stored = localStorage.getItem(key);
    return stored ? (JSON.parse(stored) as SourceImageProps[]) : [];
  }

  function addToHistory(value: SourceImageProps) {
    const items = uniqBy([value, ...getHistory()], 'url').splice(0, 30);
    localStorage.setItem(key, JSON.stringify(items));
  }

  function removeFromHistory(url: string) {
    const items = getHistory().filter((x) => x.url !== url);
    localStorage.setItem(key, JSON.stringify(items));
  }

  useEffect(() => {
    if (_value) addToHistory(_value);
  }, [_value]);

  return (
    <>
      <Input.Wrapper
        {...inputWrapperProps}
        error={error ?? inputWrapperProps.error}
        className={className}
      >
        {/* <ActionIcon size="xs">
            <IconHistory />
          </ActionIcon> */}
        <div className="relative flex size-full items-stretch justify-center rounded-md bg-gray-2 dark:bg-dark-6">
          {!_value ? (
            <ImageDropzone
              allowExternalImageDrop
              onDrop={handleDrop}
              count={_value ? 1 : 0}
              max={1}
              maxSize={maxOrchestratorImageFileSize}
              label="Drag image here or click to select a file"
              onDropCapture={handleDropCapture}
              loading={(loading || isLoading) && !isError}
              iconSize={iconSize}
            >
              {children}
            </ImageDropzone>
          ) : (
            <div className="flex max-h-96 justify-center ">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={_value.url}
                alt="image to refine"
                className="max-h-full shadow-sm shadow-black"
                onLoad={() => setLoaded(true)}
                onError={() => removeFromHistory(_value.url)}
              />
              {loaded && removable && (
                <CloseButton
                  color="red"
                  variant="filled"
                  className="absolute right-0 top-0 rounded-tr-none"
                  onClick={() => handleChange()}
                />
              )}
              {loaded && (
                <div className="absolute bottom-0 right-0 rounded-tl-md bg-dark-9/50 px-2 text-white">
                  {_value.width} x {_value.height}
                </div>
              )}
            </div>
          )}
        </div>
      </Input.Wrapper>
    </>
  );
}

export const InputSourceImageUpload = withController(SourceImageUpload, ({ field }) => ({
  value: field.value,
}));
