import type { FileInputProps } from '@mantine/core';
import { Stack, FileInput, Progress, Group, Text, Box } from '@mantine/core';
import { IconUpload, IconCircleCheck, IconBan } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { useS3Upload } from '~/hooks/useS3Upload';
import useIsClient from '~/hooks/useIsClient';
import { formatBytes, formatSeconds } from '~/utils/number-helpers';
import { getFileExtension } from '~/utils/string-helpers';
import { toStringList } from '~/utils/array-helpers';
import { useDidUpdate } from '@mantine/hooks';
import { isEqual } from 'lodash-es';
import { bytesToKB } from '~/utils/number-helpers';
import type { ModelFileInput } from '~/server/schema/model-file.schema';
import type { ModelFileType } from '~/server/common/constants';
import classes from './FileInputUpload.module.scss';
import clsx from 'clsx';

export function FileInputUpload({
  uploadType = 'Model',
  onChange,
  onLoading,
  value,
  error,
  extra,
  fileName = value?.name,
  grow = false,
  stackUploadProgress = false,
  ...props
}: Props) {
  const isClient = useIsClient();
  const [state, setState] = useState<ModelFileInput | undefined>(value);
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
        // TODO Upload Bug: when upload is aborted or errored, we aren't clearing this...
        if (!url) {
          setState(undefined);
          onLoading?.(false);
          return;
        }
        onLoading?.(false);
        const value: ModelFileInput = {
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
    <Stack className={clsx(stackUploadProgress && classes.stackedProgress, grow && classes.grow)}>
      <Group gap="xs" align="flex-end" wrap="nowrap">
        <FileInput
          {...props}
          error={error ?? fileTypeError}
          leftSection={<IconUpload size={16} />}
          onChange={handleOnChange}
          value={file ?? localFile}
          className={clsx(grow && classes.grow)}
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
        {extra}
      </Group>
      {file && (
        <>
          {status === 'uploading' &&
            (stackUploadProgress ? (
              <Box className={classes.stackedProgressProgress}>
                <Progress.Root
                  size="xl"
                  radius="xs"
                  styles={{
                    root: {
                      height: '100%',
                      borderTopRightRadius: 0,
                      borderBottomRightRadius: 0,
                      width: '100%',
                    },
                    section: {
                      alignItems: 'flex-start',
                      paddingTop: 6,
                      textShadow: '0 0 2px #000',
                    },
                  }}
                  className={classes.stackedProgressBar}
                >
                  <Progress.Section
                    value={progress}
                    color={progress < 100 ? 'blue' : 'green'}
                    striped
                    animated
                  >
                    <Progress.Label>{Math.floor(progress)}%</Progress.Label>
                  </Progress.Section>
                </Progress.Root>
                <Group justify="space-between" className={classes.stackedProgressStatus}>
                  <Text className={classes.stackedProgressStatusText}>{`${formatBytes(
                    speed
                  )}/s`}</Text>
                  <Text className={classes.stackedProgressStatusText}>{`${formatSeconds(
                    timeRemaining
                  )} remaining`}</Text>
                </Group>
              </Box>
            ) : (
              <Stack gap={2}>
                <Progress.Root style={{ width: '100%' }} size="xl">
                  <Progress.Section
                    value={progress}
                    color={progress < 100 ? 'blue' : 'green'}
                    striped
                    animated
                  >
                    <Progress.Label>{Math.floor(progress)}%</Progress.Label>
                  </Progress.Section>
                </Progress.Root>
                <Group justify="space-between">
                  <Text size="xs" c="dimmed">{`${formatBytes(speed)}/s`}</Text>
                  <Text size="xs" c="dimmed">{`${formatSeconds(timeRemaining)} remaining`}</Text>
                </Group>
              </Stack>
            ))}
          {status === 'error' && (
            <Text size="xs" c="red">
              Error uploading file
            </Text>
          )}
        </>
      )}
    </Stack>
  );
}

type Props = Omit<FileInputProps, 'icon' | 'onChange' | 'value'> & {
  value?: ModelFileInput;
  onChange?: (value?: ModelFileInput) => void;
  onLoading?: (loading: boolean) => void;
  uploadType?: ModelFileType;
  fileName?: string;
  grow?: boolean;
  stackUploadProgress?: boolean;
  extra?: React.ReactNode;
};
