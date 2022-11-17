import { Stack, FileInput, Progress, FileInputProps, Group, Text } from '@mantine/core';
import { IconUpload, IconCircleCheck, IconBan } from '@tabler/icons';
import { useMemo, useState } from 'react';
import { useS3Upload } from '~/hooks/useS3Upload';
import useIsClient from '~/hooks/useIsClient';
import { formatBytes, formatSeconds } from '~/utils/number-helpers';
import { getFileExtension } from '~/utils/string-helpers';
import { toStringList } from '~/utils/array-helpers';
import { useDidUpdate } from '@mantine/hooks';
import isEqual from 'lodash/isEqual';
import { ModelFileType } from '@prisma/client';
import { bytesToKB } from '~/utils/number-helpers';
import { ModelFileProps } from '~/server/schema/model-file.schema';

export function FileInputUpload({
  uploadType = 'Model',
  onChange,
  onLoading,
  value,
  error,
  fileName = value?.name,
  ...props
}: Props) {
  const isClient = useIsClient();
  const [state, setState] = useState<ModelFileProps | undefined>(value);
  const { files, uploadToS3, resetFiles } = useS3Upload();
  const { file, progress, speed, timeRemaining, status, abort } = files[0] ?? {
    file: null,
    progress: 0,
    speed: 0,
    timeRemaining: 0,
    status: 'pending',
  };

  const [fileTypeError, setFileTypeError] = useState('');

  useDidUpdate(() => {
    const shouldUpdate = !isEqual(value, state);
    if (shouldUpdate) setState(value);
  }, [value]);

  const handleOnChange: FileInputProps['onChange'] = async (file) => {
    setFileTypeError('');

    let url: string | null = null;
    if (file) {
      const acceptTypes = props.accept?.split(',').map((ext) => ext.trim()) ?? [];
      const fileExt = '.' + getFileExtension(file.name);

      if (
        acceptTypes.length === 0 || // Accepts all files
        acceptTypes.includes(file.type) || // Check with MIME type
        acceptTypes.includes(fileExt) // Check with file extension
      ) {
        onLoading?.(true);
        const uploaded = await uploadToS3(
          file,
          uploadType === 'Model' ? 'model' : 'training-images'
        );
        url = uploaded.url;
        onLoading?.(false);
        const value: ModelFileProps = {
          sizeKB: file.size ? bytesToKB(file.size) : 0,
          type: uploadType,
          url,
          name: file.name,
        };
        setState(value);
        onChange?.(value);
      } else {
        setFileTypeError(`This input only accepts ${toStringList(acceptTypes)} files`);
        setState(undefined);
      }
    } else {
      resetFiles();
      setState(undefined);
    }
  };

  // Create a local empty file to display value in file input when editing
  const localFile = useMemo<File | undefined>(
    () => (isClient && fileName ? new File([], fileName) : undefined),
    [fileName, isClient]
  );

  return (
    <Stack>
      <FileInput
        {...props}
        error={error ?? fileTypeError}
        icon={<IconUpload size={16} />}
        onChange={handleOnChange}
        value={file ?? localFile}
        rightSection={
          file && (
            <>
              {status === 'success' && <IconCircleCheck color="green" size={24} />}
              {status === 'uploading' && (
                <IconBan
                  style={{ cursor: 'pointer' }}
                  color="red"
                  size={24}
                  onClick={() => abort()}
                />
              )}
            </>
          )
        }
      />
      {file && (
        <>
          {status === 'uploading' && (
            <Stack spacing={2}>
              <Progress
                sx={{ width: '100%' }}
                size="xl"
                value={progress}
                label={`${Math.floor(progress)}%`}
                color={progress < 100 ? 'blue' : 'green'}
                striped
                animate
              />
              <Group position="apart">
                <Text size="xs" color="dimmed">{`${formatBytes(speed)}/s`}</Text>
                <Text size="xs" color="dimmed">{`${formatSeconds(timeRemaining)} remaining`}</Text>
              </Group>
            </Stack>
          )}
          {status === 'error' && (
            <Text size="xs" color="red">
              Error uploading file
            </Text>
          )}
        </>
      )}
    </Stack>
  );
}

type Props = Omit<FileInputProps, 'icon' | 'onChange' | 'value'> & {
  value?: ModelFileProps;
  onChange?: (value?: ModelFileProps) => void;
  onLoading?: (loading: boolean) => void;
  uploadType?: ModelFileType;
  fileName?: string;
};
