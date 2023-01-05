import {
  Stack,
  FileInput,
  Progress,
  FileInputProps,
  Group,
  Text,
  createStyles,
  Box,
} from '@mantine/core';
import { IconUpload, IconCircleCheck, IconBan } from '@tabler/icons';
import { useMemo, useState } from 'react';
import { useS3Upload } from '~/hooks/useS3Upload';
import useIsClient from '~/hooks/useIsClient';
import { formatBytes, formatSeconds } from '~/utils/number-helpers';
import { getFileExtension } from '~/utils/string-helpers';
import { toStringList } from '~/utils/array-helpers';
import { useDidUpdate } from '@mantine/hooks';
import isEqual from 'lodash/isEqual';
import { bytesToKB } from '~/utils/number-helpers';
import { ModelFileInput } from '~/server/schema/model-file.schema';
import { ModelFileType } from '~/server/common/constants';

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
  const { classes, cx } = useStyles();

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
    <Stack className={cx(stackUploadProgress && classes.stackedProgress, grow && classes.grow)}>
      <Group spacing="xs" align="flex-end" noWrap>
        <FileInput
          {...props}
          error={error ?? fileTypeError}
          icon={<IconUpload size={16} />}
          onChange={handleOnChange}
          value={file ?? localFile}
          className={cx(grow && classes.grow)}
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
                <Progress
                  sx={{ width: '100%' }}
                  size="xl"
                  radius="xs"
                  value={progress}
                  label={`${Math.floor(progress)}%`}
                  color={progress < 100 ? 'blue' : 'green'}
                  styles={{
                    root: { height: '100%', borderTopRightRadius: 0, borderBottomRightRadius: 0 },
                    bar: { alignItems: 'flex-start', paddingTop: 6, textShadow: '0 0 2px #000' },
                  }}
                  className={classes.stackedProgressBar}
                  striped
                  animate
                />
                <Group position="apart" className={classes.stackedProgressStatus}>
                  <Text className={classes.stackedProgressStatusText}>{`${formatBytes(
                    speed
                  )}/s`}</Text>
                  <Text className={classes.stackedProgressStatusText}>{`${formatSeconds(
                    timeRemaining
                  )} remaining`}</Text>
                </Group>
              </Box>
            ) : (
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
                  <Text size="xs" color="dimmed">{`${formatSeconds(
                    timeRemaining
                  )} remaining`}</Text>
                </Group>
              </Stack>
            ))}
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
  value?: ModelFileInput;
  onChange?: (value?: ModelFileInput) => void;
  onLoading?: (loading: boolean) => void;
  uploadType?: ModelFileType;
  fileName?: string;
  grow?: boolean;
  stackUploadProgress?: boolean;
  extra?: React.ReactNode;
};

const useStyles = createStyles(() => ({
  stackedProgress: {
    position: 'relative',
    overflow: 'hidden',
  },
  stackedProgressProgress: {
    position: 'absolute',
    top: 1,
    left: 1,
    bottom: 1,
    width: 'calc(100% - 32px)',
    zIndex: 2,
    opacity: 1,
  },
  stackedProgressBar: {
    position: 'absolute',
    top: '0',
    width: '100%',
  },
  stackedProgressStatus: {
    position: 'absolute',
    bottom: '0',
    width: '100%',
    marginBottom: 0,
    paddingLeft: 12,
    paddingRight: 12,
    zIndex: 3,
  },
  stackedProgressStatusText: {
    fontSize: 10,
    color: '#fff',
    textShadow: '0 0 2px #000',
    fontWeight: 500,
  },
  grow: {
    flexGrow: 1,
  },
}));
