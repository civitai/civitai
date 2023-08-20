import { createStyles, Group, Text, useMantineTheme } from '@mantine/core';
import { Dropzone, DropzoneProps } from '@mantine/dropzone';
import { IconPhoto, IconUpload, IconX } from '@tabler/icons-react';
import { IMAGE_MIME_TYPE } from '~/server/common/mime-types';

export function ImageDropzone({
  disabled: initialDisabled,
  max = 10,
  hasError,
  onDrop,
  count,
  label,
  description,
  accept = IMAGE_MIME_TYPE,
  ...props
}: Props) {
  const theme = useMantineTheme();
  const { classes, cx } = useStyles();

  const canAddFiles = max - count > 0;
  const disabled = !canAddFiles || initialDisabled;
  // Replaces image/* and video/* with .jpg, .png, .mp4, etc.
  const fileExtensions = accept.map((type) => type.replace(/.*\//, '.'));

  const handleDrop = (files: File[]) => {
    onDrop?.(files.slice(0, max - count));
  };

  return (
    <Dropzone
      {...props}
      accept={accept}
      className={cx({ [classes.disabled]: disabled })}
      classNames={{
        root: hasError ? classes.error : undefined,
      }}
      disabled={!canAddFiles || disabled}
      onDrop={handleDrop}
    >
      <Group position="center" spacing="xl" style={{ minHeight: 120, pointerEvents: 'none' }}>
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

        <div>
          <Text size="xl" inline>
            {label ?? 'Drag images here or click to select files'}
          </Text>
          {description}
          <Text size="sm" color="dimmed" inline mt={7}>
            {max ? `Attach up to ${max} files` : 'Attach as many files as you like'}
            {fileExtensions.length > 0 && `. Accepted file types: ${fileExtensions.join(', ')}`}
          </Text>
        </div>
      </Group>
    </Dropzone>
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
};
