import { Group, Input, InputWrapperProps, LoadingOverlay, Paper, Stack, Text } from '@mantine/core';
import { Dropzone, FileWithPath } from '@mantine/dropzone';
import { useDidUpdate } from '@mantine/hooks';
import { useEffect, useState } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { constants } from '~/server/common/constants';
import { IMAGE_MIME_TYPE } from '~/server/common/mime-types';
import { formatBytes } from '~/utils/number-helpers';
import { IconUser } from '@tabler/icons-react';
import { isValidURL } from '~/utils/type-guards';

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
  const { uploadToCF, files: imageFiles, resetFiles } = useCFImageUpload();
  const [image, setImage] = useState<{ url: string; objectUrl?: string } | undefined>(
    typeof value === 'string' && isValidURL(value) ? { url: value } : undefined
  );
  const [error, setError] = useState('');

  const imageFile = imageFiles[0];

  const handleDrop = async (droppedFiles: FileWithPath[]) => {
    const hasLargeFile = droppedFiles.some((file) => file.size > maxSize);
    if (hasLargeFile) return setError(`File should not exceed ${formatBytes(maxSize)}`);

    setError('');
    setImage(undefined);
    resetFiles();
    const [file] = droppedFiles;

    await uploadToCF(file);
  };

  useDidUpdate(() => {
    if (!imageFile) return;
    setImage({ url: imageFile.url, objectUrl: imageFile.objectUrl });

    if (imageFile.status === 'success') {
      const { status, ...file } = imageFile;
      onChange?.(file);
    }
  }, [imageFile]);

  useEffect(() => {
    const currentValue = value ? (typeof value === 'string' ? { url: value } : value) : undefined;
    if (currentValue && image?.url !== currentValue.url) {
      setImage(currentValue);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const hasError = !!props.error || !!error;
  const showLoading = imageFile && imageFile.progress < 100;

  return (
    <Input.Wrapper {...props} error={props.error ?? error}>
      <Group style={{ alignItems: 'stretch', marginBottom: hasError ? 5 : undefined }} grow>
        <Paper
          withBorder={!image}
          style={{
            position: 'relative',
            height: `${previewWidth}px`,
            width: `${previewWidth}px`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            flexGrow: 0,
            borderRadius: '50%',
          }}
        >
          {showLoading ? (
            <LoadingOverlay visible={!!showLoading} />
          ) : !image ? (
            <IconUser size={40} />
          ) : (
            <div style={{ width: '100%', height: '100%' }}>
              <EdgeMedia
                src={image.objectUrl ?? image.url}
                style={{ minHeight: '100%', objectFit: 'cover' }}
              />
            </div>
          )}
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
