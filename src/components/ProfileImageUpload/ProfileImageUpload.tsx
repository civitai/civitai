import { Group, Input, InputWrapperProps, LoadingOverlay, Paper, Text } from '@mantine/core';
import { Dropzone, FileWithPath } from '@mantine/dropzone';
import { useDidUpdate, useListState } from '@mantine/hooks';
import produce from 'immer';
import { useState } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { constants } from '~/server/common/constants';
import { IMAGE_MIME_TYPE } from '~/server/common/mime-types';
import { formatBytes } from '~/utils/number-helpers';

type SimpleImageUploadProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: string;
  onChange?: (value: string) => void;
  previewWidth?: number;
  maxSize?: number;
};

export function ProfileImageUpload({
  value,
  onChange,
  previewWidth = 96,
  maxSize = constants.imageUpload.maxFileSize,
  ...props
}: SimpleImageUploadProps) {
  const { uploadToCF, files: imageFiles } = useCFImageUpload();
  const [files, filesHandlers] = useListState<CustomFile>(value ? [{ url: value }] : []);
  const [error, setError] = useState('');

  const handleDrop = async (droppedFiles: FileWithPath[]) => {
    const hasLargeFile = droppedFiles.some((file) => file.size > maxSize);
    if (hasLargeFile) return setError(`File should not exceed ${formatBytes(maxSize)}`);

    setError('');
    const toUpload = droppedFiles.map((file) => ({ url: URL.createObjectURL(file), file }));
    filesHandlers.setState((current) => [...toUpload.map((x) => ({ url: x.url, file: x.file }))]); //eslint-disable-line
    await Promise.all(
      toUpload.map(async (image) => {
        const { id } = await uploadToCF(image.file);
        filesHandlers.setState(
          produce((current) => {
            const index = current.findIndex((x) => x.file === image.file);
            if (index === -1) return;
            current[index].url = id;
            current[index].file = undefined;
          })
        );
        URL.revokeObjectURL(image.url);
      })
    );
  };

  useDidUpdate(() => {
    if (files) onChange?.(files[0].url);
    // don't disable the eslint-disable
  }, [files]); //eslint-disable-line

  const hasError = !!props.error || !!error;

  return (
    <Input.Wrapper {...props} error={props.error ?? error}>
      <Group style={{ alignItems: 'stretch', marginBottom: hasError ? 5 : undefined }}>
        {files.map((image, index) => {
          const match = imageFiles.find((file) => image.file === file.file);
          const { progress } = match ?? { progress: 0 };
          const showLoading = (match && progress < 100) || image.file;

          if (showLoading)
            return (
              <div key={index}>
                <Paper withBorder style={{ position: 'relative', height: '96px', width: '96px' }}>
                  <LoadingOverlay visible={!!showLoading} />
                </Paper>
              </div>
            );

          return (
            <div key={index}>
              <EdgeMedia src={image.previewUrl ?? image.url} width={previewWidth} />
            </div>
          );
        })}
        <Dropzone
          onDrop={handleDrop}
          accept={IMAGE_MIME_TYPE}
          maxFiles={1}
          sx={{
            flex: 1,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
          }}
          styles={(theme) => ({
            root: hasError ? { borderColor: theme.colors.red[6] } : undefined,
          })}
        >
          <Text color="dimmed">{`Drop image here, should not exceed ${formatBytes(maxSize)}`}</Text>
        </Dropzone>
      </Group>
    </Input.Wrapper>
  );
}
