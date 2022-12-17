import { InputWrapperProps, LoadingOverlay, Text, Input, Paper, Group } from '@mantine/core';
import { Dropzone, FileWithPath, IMAGE_MIME_TYPE } from '@mantine/dropzone';
import { useDidUpdate, useListState } from '@mantine/hooks';
import produce from 'immer';
import { EdgeImage } from '~/components/EdgeImage/EdgeImage';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';

type SimpleImageUploadProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: string;
  onChange?: (value: string) => void;
};

export function ProfileImageUpload({ value, onChange, ...props }: SimpleImageUploadProps) {
  const { uploadToCF, files: imageFiles } = useCFImageUpload();
  const [files, filesHandlers] = useListState<CustomFile>(value ? [{ url: value }] : []);

  const handleDrop = async (droppedFiles: FileWithPath[]) => {
    const toUpload = droppedFiles.map((file) => ({ url: URL.createObjectURL(file), file }));
    filesHandlers.setState((current) => [...toUpload.map((x) => ({ url: x.url, file: x.file }))]);//eslint-disable-line
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

  return (
    <Input.Wrapper {...props}>
      <Group style={{ alignItems: 'stretch' }}>
        {files.map((image, index) => {
          const match = imageFiles.find((file) => image.file === file.file);
          const { progress } = match ?? { progress: 0 };
          const showLoading = (match && progress < 100) || image.file;

          if (showLoading)
            return (
              <div key={index}>
                <Paper withBorder style={{ position: 'relative', height: '96px', width: '96px' }}>
                  <LoadingOverlay visible={showLoading ?? false} />
                </Paper>
              </div>
            );

          return (
            <div key={index}>
              <EdgeImage src={image.url} width={96} />
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
            root: !!props.error
              ? {
                  borderColor: theme.colors.red[6],
                  marginBottom: theme.spacing.xs / 2,
                }
              : undefined,
          })}
        >
          <Text color="dimmed">Drop image here</Text>
        </Dropzone>
      </Group>
    </Input.Wrapper>
  );
}
