import { createStyles, Group, Input, Stack, Text } from '@mantine/core';
import { Dropzone, DropzoneProps } from '@mantine/dropzone';
import { IconPhoto, IconUpload, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { constants } from '~/server/common/constants';
import { IMAGE_MIME_TYPE, MIME_TYPES } from '~/server/common/mime-types';
import { formatBytes } from '~/utils/number-helpers';

export function ImageDropzone({
  disabled: initialDisabled,
  max = 10,
  hasError,
  onDrop,
  count,
  label,
  description,
  accept = IMAGE_MIME_TYPE,
  maxSize = constants.imageUpload.maxFileSize,
  orientation,
  ...props
}: Props) {
  const { classes, cx, theme } = useStyles();

  const [error, setError] = useState('');

  const canAddFiles = max - count > 0;
  const disabled = !canAddFiles || initialDisabled;
  // Replaces image/* and video/* with .jpg, .png, .mp4, etc.
  // zips do not show up correctly without these extra 2 "zip" files, but we don't want to show them
  const fileExtensions = accept
    .filter((t) => t !== MIME_TYPES.xZipCompressed && t !== MIME_TYPES.xZipMultipart)
    .map((type) => type.replace(/.*\//, '.'));

  const handleDrop = (files: File[]) => {
    const hasLargeImageFiles = files.some(
      (file) => IMAGE_MIME_TYPE.includes(file.type as IMAGE_MIME_TYPE) && file.size > maxSize
    );
    if (hasLargeImageFiles) return setError(`Images should not exceed ${formatBytes(maxSize)}`);

    setError('');
    onDrop?.(files.slice(0, max - count));
  };

  const verticalOrientation = orientation === 'vertical';

  return (
    <Stack spacing={5}>
      <Dropzone
        {...props}
        accept={accept}
        className={cx({ [classes.disabled]: disabled })}
        classNames={{
          root: hasError || !!error ? classes.error : undefined,
        }}
        disabled={!canAddFiles || disabled}
        onDrop={handleDrop}
      >
        <Group
          position="center"
          spacing={verticalOrientation ? 8 : 'xl'}
          style={{
            minHeight: 120,
            pointerEvents: 'none',
            flexDirection: verticalOrientation ? 'column' : 'row',
          }}
          noWrap
        >
          <Dropzone.Accept>
            <IconUpload
              size={50}
              stroke={1.5}
              color={theme.colors[theme.primaryColor][theme.colorScheme === 'dark' ? 4 : 6]}
            />
          </Dropzone.Accept>
          <Dropzone.Reject>
            <IconX
              size={50}
              stroke={1.5}
              color={theme.colors.red[theme.colorScheme === 'dark' ? 4 : 6]}
            />
          </Dropzone.Reject>
          <Dropzone.Idle>
            <IconPhoto size={50} stroke={1.5} />
          </Dropzone.Idle>

          <Stack spacing={4} align={verticalOrientation ? 'center' : 'flex-start'}>
            <Text size="xl" inline>
              {label ?? 'Drag images here or click to select files'}
            </Text>
            {description}
            <Text size="sm" color="dimmed" inline mt={7}>
              {max ? `Attach up to ${max} files` : 'Attach as many files as you like'}
              {`, image files should not exceed ${formatBytes(maxSize)}`}
              {fileExtensions.length > 0 && `. Accepted file types: ${fileExtensions.join(', ')}`}
            </Text>
          </Stack>
        </Group>
      </Dropzone>
      {error && <Input.Error>{error}</Input.Error>}
    </Stack>
  );
}

const useStyles = createStyles((theme) => ({
  disabled: {
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.colors.gray[0],
    borderColor: theme.colorScheme === 'dark' ? theme.colors.dark[5] : theme.colors.gray[2],
    cursor: 'not-allowed',

    '& *': {
      color: theme.colorScheme === 'dark' ? theme.colors.dark[3] : theme.colors.gray[5],
    },
  },
  error: {
    borderColor: theme.colors.red[6],
    marginBottom: theme.spacing.xs / 2,
  },
}));

type Props = Omit<DropzoneProps, 'children'> & {
  count: number;
  max?: number;
  hasError?: boolean;
  label?: string;
  description?: React.ReactNode;
  accept?: string[];
  orientation?: 'vertical' | 'horizontal';
};
