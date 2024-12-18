import { CloseButton, Divider, LoadingOverlay, TextInput } from '@mantine/core';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { maxOrchestratorImageFileSize } from '~/server/common/constants';

import { useGenerationFormStore } from '~/store/generation.store';
import { getBase64 } from '~/utils/file-utils';
import { getImageData, isImage } from '~/utils/media-preprocessors';
import { trpc } from '~/utils/trpc';

export function GeneratorImageInput({
  value,
  onChange,
}: {
  value?: string;
  onChange?: (value?: string) => void;
}) {
  const [imageError, setImageError] = useState<string | undefined>();
  const [inputError, setInputError] = useState<string | undefined>();
  const { mutate, isLoading } = trpc.orchestrator.imageUpload.useMutation({
    onError: (error) => {
      setImageError(error.message);
    },
    onSuccess: (data) => {
      console.log({ data });
      // onChange?.(data.url)
    },
  });

  useEffect(() => {
    if (value)
      getImageData(value).then(({ width, height }) => {
        useGenerationFormStore.setState({ width, height });
      });
    else {
      useGenerationFormStore.setState({ width: undefined, height: undefined });
    }
  }, [value]);

  async function handleChange(value?: string) {
    if (!value) onChange?.(value);
    else mutate({ sourceImage: value });
    // onChange?.(value);
  }

  async function handleTextChange(e: React.ChangeEvent<HTMLInputElement>) {
    const result = z.string().url().safeParse(e.target.value);
    if (inputError) setInputError(undefined);
    if (!result.success) return;
    const resolved = await isImage(result.data);
    if (resolved) handleChange(result.data);
    else setInputError('invalid image url');
    // isImage(result.data).then((isImage) => (isImage ? handleChange(result.data) : onChange?.()));
  }

  async function handleDrop(files: File[]) {
    const base64 = await getBase64(files[0]);
    handleChange(base64);
  }

  return !value ? (
    <div className="relative flex flex-col gap-2">
      <LoadingOverlay visible={isLoading} />
      <TextInput
        label="Add an image"
        placeholder="Enter image url here"
        onChange={handleTextChange}
        error={inputError}
      />
      <Divider label="OR" labelPosition="center" />
      <ImageDropzone
        allowExternalImageDrop
        onDrop={handleDrop}
        count={value ? 1 : 0}
        max={1}
        maxSize={maxOrchestratorImageFileSize}
        label="Drag image here or click to select a file"
      />
    </div>
  ) : (
    <div className="flex">
      <div className="relative inline-block">
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
    </div>
  );
}
