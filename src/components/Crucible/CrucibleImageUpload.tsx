import type { InputWrapperProps } from '@mantine/core';
import { Input, Paper, Progress, Tooltip } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import { useEffect } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { ImageDropzone } from '~/components/Image/ImageDropzone/ImageDropzone';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import type { CrucibleImageSchema } from '~/server/schema/crucible.schema';
import { IMAGE_MIME_TYPE } from '~/shared/constants/mime-types';

type Props = Omit<InputWrapperProps, 'children' | 'onChange' | 'onBlur'> & {
  value?: CrucibleImageSchema | null | '';
  onChange?: (value: CrucibleImageSchema | null) => void;
  dropzoneLabel: string;
  onUploadingChange?: (uploading: boolean) => void;
  onBlur?: () => void;
  placeholder?: string;
  reset?: number;
};

export function CrucibleImageUpload({
  value,
  onChange,
  dropzoneLabel,
  onUploadingChange,
  // `withController` injects these; kept out of `wrapperProps` so they don't reach Input.Wrapper.
  onBlur,
  placeholder,
  reset,
  ...wrapperProps
}: Props) {
  const { files, uploadToCF, resetFiles } = useCFImageUpload();
  const file = files[0];
  const uploading = file?.status === 'pending' || file?.status === 'uploading' ? file : undefined;
  const image = value || null;
  const src = image ? (file?.url === image.url && file.objectUrl) || image.url : undefined;

  // The image lives in the form, not the upload hook, so a saved draft carries it across reloads.
  useEffect(() => {
    if (file?.status !== 'success') return;
    const { url, width, height, hash } = file;
    onChange?.({ url, width, height, hash });
  }, [file?.status, file?.url]); // eslint-disable-line react-hooks/exhaustive-deps

  const isUploading = !!uploading;
  useEffect(() => {
    onUploadingChange?.(isUploading);
  }, [isUploading]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDrop = (droppedFiles: File[]) => {
    resetFiles();
    for (const droppedFile of droppedFiles) uploadToCF(droppedFile);
  };

  const remove = () => {
    resetFiles();
    onChange?.(null);
  };

  return (
    <Input.Wrapper {...wrapperProps}>
      {uploading ? (
        <Paper className="relative mt-2 h-[200px] w-full" withBorder>
          <div className="flex h-full items-center justify-center">
            <Progress.Root size="xl" w="80%">
              <Progress.Section
                striped
                animated
                value={uploading.progress}
                color={uploading.progress < 100 ? 'blue' : 'green'}
              >
                <Progress.Label>{Math.floor(uploading.progress)}%</Progress.Label>
              </Progress.Section>
            </Progress.Root>
          </div>
        </Paper>
      ) : src ? (
        <div className="relative mt-2 w-full">
          <Tooltip label="Remove image">
            <LegacyActionIcon
              size="sm"
              variant="filled"
              color="red"
              onClick={remove}
              className="absolute right-2 top-2 z-10"
            >
              <IconTrash size={14} />
            </LegacyActionIcon>
          </Tooltip>
          <div className="aspect-video overflow-hidden rounded-lg">
            <EdgeMedia
              src={src}
              width={800}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          </div>
        </div>
      ) : (
        <ImageDropzone
          mt={8}
          onDrop={handleDrop}
          // A drop replaces the file, so a failed upload must not use up the one slot.
          count={0}
          max={1}
          accept={IMAGE_MIME_TYPE}
          label={dropzoneLabel}
        />
      )}
    </Input.Wrapper>
  );
}
