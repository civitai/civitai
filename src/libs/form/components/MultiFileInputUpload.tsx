import type { InputWrapperProps } from '@mantine/core';
import {
  ActionIcon,
  Group,
  Input,
  Progress,
  Stack,
  Text,
  Tooltip,
} from '@mantine/core';
import type { DropzoneProps, FileWithPath } from '@mantine/dropzone';
import { Dropzone } from '@mantine/dropzone';
import { useDidUpdate, useListState } from '@mantine/hooks';
import { IconFileUpload, IconTrash, IconUpload, IconX } from '@tabler/icons-react';
import { useState } from 'react';

import { useS3Upload } from '~/hooks/useS3Upload';
import { MIME_TYPES } from '~/server/common/mime-types';
import type { BaseFileSchema } from '~/server/schema/file.schema';
import { removeDuplicates } from '~/utils/array-helpers';
import { bytesToKB, formatBytes, formatSeconds } from '~/utils/number-helpers';
import classes from './MultiFileInputUpload.module.scss';
import clsx from 'clsx';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

type Props = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: BaseFileSchema[];
  onChange?: (value: BaseFileSchema[]) => void;
  dropzoneProps?: Omit<DropzoneProps, 'onDrop' | 'children'>;
  renderItem?: (
    file: BaseFileSchema,
    onRemove: () => void,
    onUpdate: (file: BaseFileSchema) => void
  ) => React.ReactNode;
  orientation?: 'horizontal' | 'vertical';
  showDropzoneStatus?: boolean;
  onFilesValidate?: (files: File[]) => Promise<{ valid: boolean; errors?: string[] }>;
};

export function MultiFileInputUpload({
  value,
  onChange,
  dropzoneProps,
  renderItem,
  orientation,
  showDropzoneStatus = true,
  onFilesValidate,
  ...props
}: Props) {
  const { uploadToS3, files: trackedFiles } = useS3Upload();

  const [files, filesHandlers] = useListState<BaseFileSchema>(value || []);
  const [errors, setErrors] = useState<string[]>([]);

  const handleDrop = async (droppedFiles: FileWithPath[]) => {
    setErrors([]);

    if (dropzoneProps?.maxFiles && files.length + droppedFiles.length > dropzoneProps.maxFiles) {
      setErrors(['Max files exceeded']);
      return;
    }

    if (onFilesValidate) {
      const validation = await onFilesValidate(droppedFiles);
      if (!validation.valid) {
        setErrors(validation.errors ?? []);
        return;
      }
    }

    const uploadedFiles = await Promise.all(
      droppedFiles.map((file) => uploadToS3(file, 'default'))
    );
    const successUploads = uploadedFiles
      .filter(({ url }) => !!url)
      .map((upload) => ({
        url: upload.url as string,
        name: upload.name ?? '',
        sizeKB: upload.size ? bytesToKB(upload.size) : 0,
        metadata: {},
      }));
    filesHandlers.append(...successUploads);
  };

  const handleRemove = (index: number) => {
    filesHandlers.remove(index);
    onChange?.(files.slice(0, index).concat(files.slice(index + 1)));
  };

  const handleUpdate = (file: BaseFileSchema, index: number) => {
    filesHandlers.setItem(index, file);
  };

  useDidUpdate(() => {
    if (files && files.length) onChange?.(files);
  }, [files]);

  const uploadingItems = trackedFiles.filter((file) => file.status === 'uploading');
  const hasErrors = errors.length > 0;
  const { accept, maxSize, maxFiles } = dropzoneProps ?? {};
  const rawFileExtensions = accept
    ? Array.isArray(accept)
      ? accept
      : Object.values(accept).flat()
    : [];
  const fileExtensions = rawFileExtensions
    .filter((t) => t !== MIME_TYPES.xZipCompressed && t !== MIME_TYPES.xZipMultipart)
    .map((type) => type.replace(/.*\//, '.'));
  const verticalOrientation = orientation === 'vertical';

  return (
    <Stack>
      <Input.Wrapper
        {...props}
        error={errors.length > 0 ? errors[0] : props.error}
        description={
          dropzoneProps?.maxFiles
            ? `${files.length}/${dropzoneProps.maxFiles} uploaded files`
            : props.description
        }
      >
        <Dropzone
          {...dropzoneProps}
          mt={5}
          accept={accept}
          onDrop={handleDrop}
          onReject={(files) => {
            const errors = removeDuplicates(
              files.flatMap((file) => file.errors),
              'code'
            ).map((error) => error.message);
            setErrors(errors);
          }}
          className={clsx(dropzoneProps?.className, !showDropzoneStatus && classes.dropzone)}
          classNames={{ root: props.error || hasErrors ? 'border-red-6 mb-[5px]' : undefined }}
        >
          <Group
            justify="center"
            gap={verticalOrientation ? 8 : 'xl'}
            style={{
              minHeight: 120,
              pointerEvents: 'none',
              flexDirection: verticalOrientation ? 'column' : 'row',
            }}
            wrap="nowrap"
          >
            {showDropzoneStatus ? (
              <>
                <Dropzone.Accept>
                  <IconUpload size={50} stroke={1.5} className="text-blue-6 dark:text-blue-4" />
                </Dropzone.Accept>
                <Dropzone.Reject>
                  <IconX size={50} stroke={1.5} className="text-red-6 dark:text-red-4" />
                </Dropzone.Reject>
                <Dropzone.Idle>
                  <IconFileUpload size={50} stroke={1.5} />
                </Dropzone.Idle>
              </>
            ) : (
              <IconFileUpload size={50} stroke={1.5} />
            )}
            <Stack gap={4} align={verticalOrientation ? 'center' : 'flex-start'}>
              <Text size="xl">Drop your files or click to select</Text>
              <Text c="dimmed" size="sm">
                {maxFiles ? `Attach up to ${maxFiles} files` : 'Attach as many files as you like'}
                {maxSize && `. Each file should not exceed ${formatBytes(maxSize ?? 0)}`}
                {fileExtensions.length > 0 && `. Accepted file types: ${fileExtensions.join(', ')}`}
              </Text>
            </Stack>
          </Group>
        </Dropzone>
      </Input.Wrapper>
      <Stack gap={8}>
        {files.map((file, index) => (
          <Group key={file.id ?? file.url} gap={8} justify="space-between" wrap="nowrap">
            {renderItem ? (
              renderItem(
                file,
                () => handleRemove(index),
                (file) => {
                  handleUpdate(file, index);
                }
              )
            ) : (
              <>
                <Text size="sm" fw={500} lineClamp={1}>
                  {file.name}
                </Text>
                <Tooltip label="Remove">
                  <LegacyActionIcon
                    size="sm"
                    color="red"
                    variant="transparent"
                    onClick={() => handleRemove(index)}
                  >
                    <IconTrash />
                  </LegacyActionIcon>
                </Tooltip>
              </>
            )}
          </Group>
        ))}
        {uploadingItems.map((file, index) => (
          <UploadItem key={index} {...file} />
        ))}
      </Stack>
    </Stack>
  );
}

type UploadItemProps = Pick<TrackedFile, 'progress' | 'speed' | 'timeRemaining' | 'abort' | 'name'>;
function UploadItem({ progress, speed, timeRemaining, abort, name }: UploadItemProps) {
  return (
    <Stack gap={4}>
      <Group gap={8} justify="space-between" wrap="nowrap">
        <Text size="sm" fw={500} lineClamp={1}>
          {name}
        </Text>
        <Tooltip label="Cancel">
          <LegacyActionIcon size="sm" color="red" variant="transparent" onClick={() => abort()}>
            <IconX />
          </LegacyActionIcon>
        </Tooltip>
      </Group>
      <Stack gap={2}>
        <Progress.Root className="w-full" size="xl">
          <Progress.Section
            value={progress}
            color={progress < 100 ? 'blue' : 'green'}
            striped
            animated
          >
            <Progress.Label>{Math.floor(progress)}</Progress.Label>
          </Progress.Section>
        </Progress.Root>
        <Group justify="space-between">
          <Text size="xs" c="dimmed">{`${formatBytes(speed)}/s`}</Text>
          <Text size="xs" c="dimmed">{`${formatSeconds(timeRemaining)} remaining`}</Text>
        </Group>
      </Stack>
    </Stack>
  );
}
