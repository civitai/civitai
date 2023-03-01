import {
  ActionIcon,
  Button,
  Card,
  createStyles,
  Group,
  Progress,
  Stack,
  Text,
  Tooltip,
  useMantineTheme,
} from '@mantine/core';
import { Dropzone, FileWithPath } from '@mantine/dropzone';
import { ModelType } from '@prisma/client';
import {
  IconBan,
  IconCircleCheck,
  IconFileUpload,
  IconTrash,
  IconUpload,
  IconX,
} from '@tabler/icons';
import capitalize from 'lodash/capitalize';

import { useWizardContext } from '~/components/Resource/Wizard/Wizard';
import { ModelFileType } from '~/server/common/constants';
import { UploadType } from '~/server/common/enums';
import { ModelVersionUpsertInput } from '~/server/schema/model-version.schema';
import { ModelUpsertInput } from '~/server/schema/model.schema';
import { useS3UploadStore } from '~/store/s3-upload.store';
import { bytesToKB, formatBytes, formatSeconds } from '~/utils/number-helpers';
import { trpc } from '~/utils/trpc';

// const mapFileTypeAcceptedFileType: Record<ModelFileType, string> = {
//   Model: '.ckpt,.pt,.safetensors,.bin',
//   'Pruned Model': '.ckpt,.pt,.safetensors',
//   Negative: '.pt,.bin',
//   'Training Data': '.zip',
//   Config: '.yaml,.yml',
//   VAE: '.pt,.ckpt,.safetensors',
//   'Text Encoder': '.pt',
// };

// const fileTypesByModelType: Record<ModelType, ModelFileType[]> = {
//   TextualInversion: ['Model', 'Negative', 'Training Data'],
//   LORA: ['Model', 'Text Encoder', 'Training Data'],
//   Checkpoint: ['Model', 'Pruned Model', 'Config', 'VAE', 'Training Data'],
//   AestheticGradient: ['Model', 'Training Data'],
//   Hypernetwork: ['Model', 'Training Data'],
// };

/*
TODO.posts
  - list files
  - add new files
  - update context/store with upload results
  - trpc.modelfiles.create on upload complete
*/

export function Files({ model, version }: Props) {
  const { goNext, goBack } = useWizardContext();
  const theme = useMantineTheme();
  const { items, clear, upload, abort } = useS3UploadStore();

  const createFileMutation = trpc.modelFile.create.useMutation();
  const deleteFileMutation = trpc.modelFile.delete.useMutation();
  // TODO.posts: add delete file handler
  // TODO.posts: sync data with server

  const handleDrop = async (droppedFiles: FileWithPath[]) => {
    await Promise.all(
      droppedFiles.map((file) =>
        upload(
          { file, type: UploadType.Model, meta: { versionId: version?.id } },
          ({ meta, size, ...result }) => {
            const { versionId } = meta as { versionId: number };
            const sizeKB = size ? bytesToKB(file.size) : 0;
            createFileMutation.mutate({
              ...result,
              sizeKB,
              modelVersionId: versionId,
              type: 'Model',
            });
          }
        )
      )
    );
  };

  const versionFiles = items.filter((item) => item.meta?.versionId === version?.id);
  const uploading = versionFiles.some((file) => file.status === 'uploading');

  return (
    <Stack spacing="xs">
      <Dropzone onDrop={handleDrop}>
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
            <IconFileUpload size={50} stroke={1.5} />
          </Dropzone.Idle>

          <Stack spacing={8}>
            <Text size="xl" inline>
              Drop your files here or click to select
            </Text>
            <Text size="sm" color="dimmed" inline>
              Attach as many files as you like
            </Text>
          </Stack>
        </Group>
      </Dropzone>
      {/* TODO.list */}
      {versionFiles && versionFiles.length ? (
        <Card withBorder>
          <Stack py="xs">
            {versionFiles.map(({ uuid, status, name, progress, timeRemaining, speed }) => {
              const failedUpload = status === 'error' || status === 'aborted';

              return (
                <Group key={uuid} spacing="xs" position="apart" align="flex-start">
                  <Stack spacing={4} sx={{ flex: 1 }}>
                    <Group spacing="xs" align="flex-start">
                      {status === 'success' && <IconCircleCheck color="green" />}
                      {failedUpload && <IconBan color="red" />}
                      <Stack spacing={0}>
                        <Text lineClamp={1} color={failedUpload ? 'red' : undefined}>
                          {name}
                        </Text>
                        <Text color="dimmed" size="xs">
                          {capitalize(status)}
                        </Text>
                      </Stack>
                    </Group>
                    {status === 'uploading' && (
                      <Stack spacing={4}>
                        <Progress
                          size="xl"
                          radius="xs"
                          value={progress}
                          label={`${Math.floor(progress)}%`}
                          color={progress < 100 ? 'blue' : 'green'}
                        />
                        <Group position="apart">
                          <Text color="dimmed" size="xs">{`${formatBytes(speed)}/s`}</Text>
                          <Text color="dimmed" size="xs">{`${formatSeconds(
                            timeRemaining
                          )} remaining`}</Text>
                        </Group>
                      </Stack>
                    )}
                  </Stack>
                  <Group>
                    {status === 'uploading' ? (
                      <Tooltip label="Cancel upload">
                        <ActionIcon color="red" onClick={() => abort(uuid)}>
                          <IconX />
                        </ActionIcon>
                      </Tooltip>
                    ) : (
                      <Tooltip label="Remove file">
                        <ActionIcon color="red" onClick={() => clear((file) => file.uuid === uuid)}>
                          <IconTrash />
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </Group>
                </Group>
              );
            })}
          </Stack>
          {/* TODO.file type select */}
        </Card>
      ) : null}
      <Group position="right" mt="xl">
        <Button variant="default" onClick={goBack}>
          Back
        </Button>
        <Button onClick={goNext} loading={uploading}>
          {uploading ? 'Uploading...' : 'Next'}
        </Button>
      </Group>
    </Stack>
  );
}

type Props = {
  model?: ModelUpsertInput;
  version?: ModelVersionUpsertInput;
};

// export function Files({ modelVersionId }: FilesProps) {
//   const { items, reset, upload, abort } = useS3UploadStore();

//   const { mutate } = trpc.modelFile.create.useMutation({
//     onSuccess: () => {
//       // update/invalidate cache
//     },
//   });

//   const handleDropFile = (file: File) => {
//     upload({ file, type: UploadType.Model, meta: { modelVersionId } }, ({ url, bucket, key }) => {
//       mutate({
//         sizeKB: file.size ? bytesToKB(file.size) : 0,
//         type: 'Model',
//         url,
//         name: file.name,
//         modelVersionId,
//       });
//     });
//   };

//   return (
//     <>
//       {items
//         .filter((x) => x.meta.modelVersionId === modelVersionId)
//         .map((item) => {
//           const { modelVersionId } = item.meta as { modelVersionId?: number };
//           return <>Model version details and progress</>;
//         })}
//     </>
//   );
// }
