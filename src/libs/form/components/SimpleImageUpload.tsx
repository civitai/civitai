import {
  ActionIcon,
  Box,
  Group,
  Input,
  InputWrapperProps,
  LoadingOverlay,
  Paper,
  Text,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { Dropzone, FileWithPath, IMAGE_MIME_TYPE } from '@mantine/dropzone';
import { useDidUpdate } from '@mantine/hooks';
import { IconPhoto, IconTrash, IconUpload, IconX } from '@tabler/icons';
import { useState } from 'react';

import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';

type SimpleImageUploadProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: string;
  onChange?: (value: string | null) => void;
  previewWidth?: number;
};

export function SimpleImageUpload({ value, onChange, ...props }: SimpleImageUploadProps) {
  const theme = useMantineTheme();
  const { uploadToCF, files: imageFiles } = useCFImageUpload();
  // const [files, filesHandlers] = useListState<CustomFile>(value ? [{ url: value }] : []);
  const [image, setImage] = useState<CustomFile | undefined>(value ? { url: value } : undefined);

  const handleDrop = async (droppedFiles: FileWithPath[]) => {
    const [file] = droppedFiles;
    const toUpload = { url: URL.createObjectURL(file), file };
    setImage((current) => ({ ...current, url: toUpload.url, file: toUpload.file }));

    const { id } = await uploadToCF(toUpload.file);
    setImage((current) => ({ ...current, url: id, file: undefined }));
    URL.revokeObjectURL(toUpload.url);
  };

  const handleRemove = () => {
    setImage(undefined);
    onChange?.(null);
  };

  useDidUpdate(() => {
    if (image) onChange?.(image.url);
    // don't disable the eslint-disable
  }, [image]); //eslint-disable-line

  const match = imageFiles.find((file) => image?.file === file.file);
  const { progress } = match ?? { progress: 0 };
  const showLoading = (match && progress < 100) || image?.file;

  return (
    <Input.Wrapper {...props}>
      {showLoading ? (
        <Paper
          style={{ position: 'relative', marginTop: 5, width: '100%', height: 200 }}
          withBorder
        >
          <LoadingOverlay visible />
        </Paper>
      ) : image ? (
        <div style={{ position: 'relative', width: '100%', marginTop: 5 }}>
          <Tooltip label="Remove image">
            <ActionIcon
              size="sm"
              variant="light"
              color="red"
              onClick={handleRemove}
              sx={(theme) => ({
                position: 'absolute',
                top: theme.spacing.xs * 0.4,
                right: theme.spacing.xs * 0.4,
              })}
            >
              <IconTrash />
            </ActionIcon>
          </Tooltip>

          <Box
            sx={(theme) => ({
              height: 'calc(100vh / 3)',
              '& > img': {
                height: '100%',
                objectFit: 'cover',
                borderRadius: theme.radius.md,
              },
            })}
          >
            <EdgeImage src={image.previewUrl ?? image.url} width={450} />
          </Box>
        </div>
      ) : (
        <Dropzone
          onDrop={handleDrop}
          accept={IMAGE_MIME_TYPE}
          maxFiles={1}
          mt={5}
          styles={(theme) => ({
            root: !!props.error
              ? {
                  borderColor: theme.colors.red[6],
                  marginBottom: theme.spacing.xs / 2,
                }
              : undefined,
          })}
        >
          <Dropzone.Accept>
            <Group position="center" spacing="xs">
              <IconUpload
                size={32}
                stroke={1.5}
                color={theme.colors[theme.primaryColor][theme.colorScheme === 'dark' ? 4 : 6]}
              />
              <Text color="dimmed">Drop image here</Text>
            </Group>
          </Dropzone.Accept>
          <Dropzone.Reject>
            <Group position="center" spacing="xs">
              <IconX
                size={32}
                stroke={1.5}
                color={theme.colors.red[theme.colorScheme === 'dark' ? 4 : 6]}
              />
              <Text>File not accepted</Text>
            </Group>
          </Dropzone.Reject>
          <Dropzone.Idle>
            <Group position="center" spacing="xs">
              <IconPhoto size={32} stroke={1.5} />
              <Text color="dimmed">Drop image here</Text>
            </Group>
          </Dropzone.Idle>
        </Dropzone>
      )}
    </Input.Wrapper>
  );
}
