import {
  CloseButton,
  Divider,
  LoadingOverlay,
  TextInput,
  Input,
  Card,
  Switch,
  Text,
  Paper,
  Collapse,
} from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { maxOrchestratorImageFileSize, isOrchestratorUrl } from '~/server/common/constants';

import { useGenerationFormStore } from '~/store/generation.store';
import { getBase64 } from '~/utils/file-utils';
import { getImageData, isImage } from '~/utils/media-preprocessors';
import { trpc } from '~/utils/trpc';
import clsx from 'clsx';
import { useLocalStorage } from '@mantine/hooks';

// TODO - if the image is being uploaded, don't make a whatIf query
export function GeneratorImageInput({
  value,
  onChange,
}: {
  value?: string;
  onChange?: (value?: string) => void;
}) {
  const textInputRef = useRef<HTMLInputElement>(null);
  const [imageError, setImageError] = useState<string | undefined>();
  const [inputError, setInputError] = useState<string | undefined>();
  const { mutate, isLoading } = trpc.orchestrator.imageUpload.useMutation({
    onError: (error) => {
      setImageError(error.message);
    },
    onSuccess: ({ blob }) => {
      onChange?.(blob.url ?? undefined);
      setImageError(undefined);
    },
  });

  useEffect(() => {
    if (value) {
      getImageData(value).then(({ width, height }) => {
        useGenerationFormStore.setState({ width, height });
      });
    } else {
      useGenerationFormStore.setState({ width: undefined, height: undefined });
      if (textInputRef.current) textInputRef.current.value = '';
    }
  }, [value]);

  async function handleChange(value?: string) {
    // checking if the url comes from the orchestrator prevents us from having to upload images that the orchestrator already has
    if (!value || isOrchestratorUrl(value)) {
      onChange?.(value);
      setImageError(undefined);
    } else mutate({ sourceImage: value });
  }

  async function handleTextChange(value: string) {
    const result = z.string().url().safeParse(value.trim());
    if (inputError) setInputError(undefined);
    if (!result.success) return;
    const resolved = await isImage(result.data);
    if (resolved) handleChange(result.data);
    else setInputError('invalid image url');
  }

  async function handleDrop(files: File[]) {
    const base64 = await getBase64(files[0]);
    handleChange(base64);
  }

  async function handleDropCapture(url: string) {
    handleChange(url);
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="relative flex flex-col items-center justify-center">
        <div className={clsx('relative flex w-full flex-col gap-2', { ['invisible']: value })}>
          <LoadingOverlay visible={isLoading} />
          <TextInput
            ref={textInputRef}
            label="Add an image"
            placeholder="Enter image url here"
            onChange={(e) => handleTextChange(e.target.value)}
            error={inputError}
            onDrop={(e) => {
              e.preventDefault();
              e.currentTarget.value = e.dataTransfer.getData('text/uri-list');
              handleTextChange(e.currentTarget.value);
            }}
          />
          <Divider label="OR" labelPosition="center" />
          <ImageDropzone
            allowExternalImageDrop
            onDrop={handleDrop}
            count={value ? 1 : 0}
            max={1}
            maxSize={maxOrchestratorImageFileSize}
            label="Drag image here or click to select a file"
            onDropCapture={handleDropCapture}
          />
        </div>
        {value && (
          <div className="absolute inset-0 flex">
            <ImageWithCloseButton value={value} onChange={onChange} />
          </div>
        )}
      </div>
      {imageError && <Input.Error className="mt-1">{imageError}</Input.Error>}
    </div>
  );
}

function ImageWithCloseButton({
  value,
  onChange,
}: {
  value?: string;
  onChange?: (value?: string) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="relative">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={value}
        alt="image to refine"
        className="max-h-full rounded-md shadow-sm shadow-black"
        onLoad={() => setLoaded(true)}
      />
      {loaded && (
        <CloseButton
          color="red"
          variant="filled"
          className="absolute right-0 top-0"
          onClick={() => onChange?.()}
        />
      )}
    </div>
  );
}

export function AccordionGeneratorImageInput({
  value,
  onChange,
}: {
  value?: string;
  onChange?: (value?: string) => void;
}) {
  const [checked, setChecked] = useLocalStorage({ key: 'byoi', defaultValue: value !== undefined });
  const actuallyChecked = checked || !!value?.length;

  return (
    <Card withBorder p={0}>
      <Card.Section p="xs" className="flex items-center justify-between">
        <Text weight={500}>Start from an image</Text>
        <Switch
          checked={actuallyChecked}
          onChange={(e) => {
            const checked = e.target.checked;
            setChecked(e.target.checked);
            if (!checked) onChange?.(undefined);
          }}
        />
      </Card.Section>
      <Collapse in={actuallyChecked}>
        <Card.Section withBorder className="border-b-0">
          <Paper p="xs">
            <GeneratorImageInput value={value} onChange={onChange} />
          </Paper>
        </Card.Section>
      </Collapse>
    </Card>
  );
}
