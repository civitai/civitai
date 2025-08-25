import type { InputWrapperProps } from '@mantine/core';
import { Input, CloseButton, Alert } from '@mantine/core';
import { trpc } from '~/utils/trpc';
import { forwardRef, useEffect, useState } from 'react';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { maxOrchestratorImageFileSize, maxUpscaleSize } from '~/server/common/constants';
import { withController } from '~/libs/form/hoc/withController';
import { fetchBlobAsFile, getBase64 } from '~/utils/file-utils';
import type { SourceImageProps } from '~/server/orchestrator/infrastructure/base.schema';
import { imageToJpegBlob, resizeImage } from '~/shared/utils/canvas-utils';
import { getImageDimensions } from '~/utils/image-utils';

import { uniqBy } from 'lodash-es';
import { ExifParser } from '~/utils/metadata';
import clsx from 'clsx';

const key = 'img-uploads';
const timeoutError = 'Gateway Time-out';
export type SourceImageUploadProps = {
  value?: SourceImageProps | null;
  onChange?: (value?: SourceImageProps | null) => void;
  removable?: boolean;
  children?: React.ReactNode;
  iconSize?: number;
  warnOnMissingAiMetadata?: boolean;
  onWarnMissingAiMetadata?: (Warning: JSX.Element | null) => void;
} & Omit<InputWrapperProps, 'children' | 'value' | 'onChange'>;

export const SourceImageUpload = forwardRef<HTMLDivElement, SourceImageUploadProps>(
  (
    {
      value,
      onChange,
      removable = true,
      label,
      children,
      iconSize,
      error: inputError,
      warnOnMissingAiMetadata,
      onWarnMissingAiMetadata,
      ...inputWrapperProps
    },
    ref
  ) => {
    const [loaded, setLoaded] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // const [warning, setWarning] = useState<string | null>(null);
    const [Warning, setWarning] = useState<JSX.Element | null>(null);
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

    function handleWarnOnMissingAiMetadata(Warning: JSX.Element | null) {
      setWarning(Warning);
      if (onWarnMissingAiMetadata) onWarnMissingAiMetadata(Warning);
    }

    function handleUrlChange(url: string) {
      getImageDimensions(url).then(({ width, height }) => {
        setError(null);
        handleWarnOnMissingAiMetadata(null);
        onChange?.({ url, width, height });
      });
    }

    function handleChange(value?: string) {
      setError(null);
      handleWarnOnMissingAiMetadata(null);
      if (!value) onChange?.(null);
      else mutate({ sourceImage: value });
    }

    async function handleDrop(files: File[]) {
      handleDropCapture(files[0]);
    }

    async function handleDropCapture(src: File | Blob | string) {
      setLoading(true);
      try {
        const resized = await resizeImage(src, {
          maxHeight: maxUpscaleSize,
          maxWidth: maxUpscaleSize,
        });
        const jpegBlob = await imageToJpegBlob(resized);
        const base64 = await getBase64(jpegBlob);
        if (base64) handleChange(base64);
      } catch (e) {
        setLoading(false);
      }
    }

    useEffect(() => {
      if (!error || error === timeoutError) {
        if (value && typeof value === 'string' && (value as string).length > 0)
          handleUrlChange(value);
        else if (value && value instanceof Blob) handleDropCapture(value);
      } else if (error) {
        onChange?.(null);
      }
    }, [value, error]);

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
      if (_value && loaded) {
        addToHistory(_value);

        if (warnOnMissingAiMetadata || onWarnMissingAiMetadata) {
          fetchBlobAsFile(_value.url).then(async (file) => {
            if (file) {
              const parser = await ExifParser(file);

              const meta = await parser.getMetadata();
              if (!Object.keys(meta).length && !parser.isMadeOnSite()) {
                handleWarnOnMissingAiMetadata(
                  <Alert color="yellow" title="We couldn't detect valid metadata in this image.">
                    {`Outputs based on this image must be PG, PG-13, or they will be blocked and you will not be refunded.`}
                  </Alert>
                );
              } else handleWarnOnMissingAiMetadata(null);
            }
          });
        }
      }
    }, [_value, warnOnMissingAiMetadata, loaded]);

    function handleRemoveItem() {
      onChange?.();
    }

    function handleError() {
      handleRemoveItem();
      setError('Failed to load image');
    }

    const _error = error ?? inputError;
    const showError = !!_error && _error !== timeoutError;

    return (
      <div className="flex flex-1 flex-col gap-2" ref={ref}>
        <Input.Wrapper
          {...inputWrapperProps}
          className={clsx({
            ['rounded-md border-2 border-solid border-yellow-4 ']: Warning,
          })}
        >
          {/* <ActionIcon size="xs">
            <IconHistory />
          </ActionIcon> */}
          {!_value ? (
            <div className="flex aspect-video size-full max-h-72 flex-col rounded-md">
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
                // onMissingAiMetadata={warnOnMissingAiMetadata ? handleMissingAiMetadata : undefined}
              >
                {children}
              </ImageDropzone>
              {showError && <Input.Error>{_error}</Input.Error>}
            </div>
          ) : (
            <div
              className={clsx(
                'relative flex aspect-video size-full max-h-72 items-stretch justify-center overflow-hidden rounded-md bg-gray-2 dark:bg-dark-6'
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={_value.url}
                alt="image to refine"
                className="mx-auto max-h-full"
                onLoad={(e) => {
                  setLoaded(true);
                }}
                onError={() => {
                  removeFromHistory(_value.url);
                  onChange?.(null);
                }}
              />
              {loaded && removable && (
                <CloseButton
                  color="red"
                  variant="filled"
                  className="absolute right-0 top-0 rounded-md"
                  onClick={handleRemoveItem}
                />
              )}
              {loaded && (
                <div className="absolute bottom-0 right-0 rounded-br-md rounded-tl-md bg-dark-9/50 px-2 text-white">
                  {_value.width} x {_value.height}
                </div>
              )}
            </div>
          )}
        </Input.Wrapper>
        {!onWarnMissingAiMetadata ? Warning : null}
      </div>
    );
  }
);

SourceImageUpload.displayName = 'SourceImageUpload';

// export function SourceImageUpload({
//   value,
//   onChange,
//   removable = true,
//   label,
//   children,
//   iconSize,
//   error: inputError,
//   warnOnMissingAiMetadata,
//   onWarnMissingAiMetadata,
//   ...inputWrapperProps
// }: SourceImageUploadProps) {

// }

export const InputSourceImageUpload = withController(SourceImageUpload, ({ field }) => ({
  value: field.value,
}));
