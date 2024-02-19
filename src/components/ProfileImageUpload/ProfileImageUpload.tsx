import { Group, Input, InputWrapperProps, LoadingOverlay, Paper, Stack, Text } from '@mantine/core';
import { Dropzone, FileWithPath } from '@mantine/dropzone';
import { useDidUpdate, useListState } from '@mantine/hooks';
import produce from 'immer';
import { useEffect, useState } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { constants } from '~/server/common/constants';
import { IMAGE_MIME_TYPE } from '~/server/common/mime-types';
import { formatBytes } from '~/utils/number-helpers';
import { IconUser } from '@tabler/icons-react';

type SimpleImageUploadProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: string | { url: string };
  onChange?: (value: CustomFile) => void;
  previewWidth?: number;
  maxSize?: number;
  previewDisabled?: boolean;
};

export function ProfileImageUpload({
  value,
  onChange,
  previewWidth = 96,
  maxSize = constants.mediaUpload.maxImageFileSize,
  previewDisabled,
  ...props
}: SimpleImageUploadProps) {
  const { uploadToCF, files: imageFiles } = useCFImageUpload();
  const [files, filesHandlers] = useListState<CustomFile>(
    value ? (typeof value === 'string' ? [{ url: value }] : [value]) : []
  );
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
    const [imageFile] = imageFiles;

    if (!imageFile) {
      return;
    }

    if (imageFile.status === 'success') {
      const { status, ...file } = imageFile;
      onChange?.(file);
    }
    // don't disable the eslint-disable
  }, [imageFiles]); // eslint-disable-line

  useEffect(() => {
    const currentValue = value ? (typeof value === 'string' ? { url: value } : value) : undefined;
    if (currentValue && files[0]?.url !== currentValue.url) {
      filesHandlers.setState([currentValue]);
    }
  }, [value]);
  const hasError = !!props.error || !!error;

  return (
    <Input.Wrapper {...props} error={props.error ?? error}>
      <Group style={{ alignItems: 'stretch', marginBottom: hasError ? 5 : undefined }} grow>
        <Paper
          withBorder={files.length === 0}
          style={{
            position: 'relative',
            height: `${previewWidth}px`,
            width: `${previewWidth}px`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            flexGrow: 0,
          }}
          radius="md"
        >
          {files.length === 0 && <IconUser size={40} />}
          {files.map((image, index) => {
            const match = imageFiles.find((file) => image.file === file.file);
            const { progress } = match ?? { progress: 0 };
            const showLoading = (match && progress < 100) || image.file;

            if (showLoading)
              return (
                <div key={index}>
                  <LoadingOverlay visible={!!showLoading} />
                </div>
              );

            return (
              <div key={index}>
                <EdgeMedia src={image.previewUrl ?? image.url} width="original" />
              </div>
            );
          })}
        </Paper>

        <Stack maw="unset">
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
            radius="md"
            styles={(theme) => ({
              root: hasError ? { borderColor: theme.colors.red[6] } : undefined,
            })}
          >
            <Text color="dimmed">{`Drop image here, should not exceed ${formatBytes(
              maxSize
            )}`}</Text>
          </Dropzone>
        </Stack>
      </Group>
    </Input.Wrapper>
  );
}
