import { Group, useMantineTheme, createStyles, Text } from '@mantine/core';
import { Dropzone, DropzoneProps, IMAGE_MIME_TYPE } from '@mantine/dropzone';
import { IconUpload, IconX, IconPhoto } from '@tabler/icons';

export function ImageDropzone({
  disabled: initialDisabled,
  max = 10,
  hasError,
  onDrop,
  count,
  ...props
}: Omit<DropzoneProps, 'children'> & { max?: number; hasError?: boolean; count: number }) {
  const theme = useMantineTheme();
  const { classes, cx } = useStyles();

  const canAddFiles = max - count > 0;
  const disabled = !canAddFiles || initialDisabled;
  const handleDrop = (files: File[]) => {
    onDrop?.(files.slice(0, max - count));
  };

  return (
    <Dropzone
      {...props}
      accept={IMAGE_MIME_TYPE}
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
            Drag images here or click to select files
          </Text>
          <Text size="sm" color="dimmed" inline mt={7}>
            {max ? `Attach up to ${max} files` : 'Attach as many files as you like'}
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
