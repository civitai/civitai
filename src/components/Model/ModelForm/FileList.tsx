import { ActionIcon, Anchor, Group, InputWrapperProps, Stack } from '@mantine/core';
import { ModelFileFormat, ModelType } from '@prisma/client';
import { IconTrash } from '@tabler/icons';
import { useEffect, useState } from 'react';
import { useFieldArray, UseFormReturn } from 'react-hook-form';

import { PopConfirm } from '~/components/PopConfirm/PopConfirm';
import { InputFileUpload } from '~/libs/form';
import { ModelFileType } from '~/server/common/constants';
import { ModelFileInput } from '~/server/schema/model-file.schema';
import { splitUppercase } from '~/utils/string-helpers';

const fileFormats = Object.values(ModelFileFormat).filter((type) => type !== 'Other');
const fileFormatCount = fileFormats.length;

const mapFileTypeAcceptedFileType: Record<ModelFileType, string> = {
  Model: '.ckpt,.pt,.safetensors,.bin',
  'Pruned Model': '.ckpt,.pt,.safetensors',
  Negative: '.pt,.bin',
  'Training Data': '.zip',
  Config: '.yaml,.yml',
  VAE: '.pt,.ckpt,.safetensors',
  'Text Encoder': '.pt',
  Archive: '.zip',
};

const fileTypesByModelType: Record<ModelType, ModelFileType[]> = {
  TextualInversion: ['Model', 'Negative', 'Training Data'],
  LORA: ['Model', 'Text Encoder', 'Training Data'],
  Checkpoint: ['Model', 'Pruned Model', 'Config', 'VAE', 'Training Data'],
  AestheticGradient: ['Model', 'Training Data'],
  Hypernetwork: ['Model', 'Training Data'],
  Controlnet: ['Model'],
  Poses: ['Archive'],
};

export function FileList({ parentIndex, form }: Props) {
  const files = form.watch(`modelVersions.${parentIndex}.files`) as ModelFileInput[];
  const modelType = form.watch('type') as ModelType;
  const isCheckpointModel = modelType === 'Checkpoint';
  const availableFileTypes = fileTypesByModelType[modelType];
  const fileTypeCount = availableFileTypes.length;
  // We reduce by 2 when is not checkpoint cause we don't need prunedModel
  const maxLength = fileTypeCount + fileFormatCount - (isCheckpointModel ? 0 : 2);

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: `modelVersions.${parentIndex}.files`,
    rules: {
      maxLength,
      minLength: 1,
      required: true,
    },
  });

  const handleAddFileInput = (type: ModelFileType) => {
    append({
      type,
      url: '',
      name: '',
      sizeKB: 0,
    });
  };

  // Check if user changed model type to remove prunedModel files
  useEffect(() => {
    if (!isCheckpointModel) {
      for (let i = 0; i < files.length; i++) {
        const isPruned = files[i].type === 'Pruned Model';
        if (!isPruned) continue;

        remove(i);
      }
    }
  }, [files, isCheckpointModel, remove]);

  // We only want to check for files that are not model or prunedModel
  // to prevent the user from selecting the same file type
  const selectedTypes = files
    .map(({ type }) => type)
    .filter((type) => !['Model', 'Pruned Model'].includes(type));
  const reachedLimit = fields.length >= maxLength;
  const reachedModelLimit =
    isCheckpointModel && files.filter((item) => item.type === 'Model').length >= fileFormatCount;
  const reachedPrunedLimit =
    isCheckpointModel &&
    files.filter((item) => item.type === 'Pruned Model').length >= fileFormatCount;

  return (
    <Stack spacing="xs">
      {fields.map(({ id, ...item }, index) => {
        const file = item as ModelFileInput;
        const type = !availableFileTypes.includes(file.type) ? availableFileTypes[0] : file.type;

        return (
          <Stack key={id} spacing={5}>
            <FileItem
              {...file}
              type={type}
              index={index}
              parentIndex={parentIndex}
              modelType={modelType}
              onRemoveClick={(index) => remove(index)}
            />
            {index === 0 && (
              <Group spacing="xs">
                {availableFileTypes.map((type, index) => {
                  if (type === availableFileTypes[0] && !isCheckpointModel) return null;
                  const disableModelOption = type === 'Model' && reachedModelLimit;
                  const disablePrunedOption = type === 'Pruned Model' && reachedPrunedLimit;
                  const disabled =
                    reachedLimit ||
                    selectedTypes.includes(type) ||
                    disableModelOption ||
                    disablePrunedOption;

                  return (
                    <Anchor
                      key={index}
                      component="button"
                      size="xs"
                      disabled={disabled}
                      color={disabled ? 'dimmed' : undefined}
                      sx={{ cursor: disabled ? 'not-allowed' : undefined }}
                      onClick={!disabled ? () => handleAddFileInput(type) : undefined}
                    >
                      {`+ Add ${type}`}
                    </Anchor>
                  );
                })}
              </Group>
            )}
          </Stack>
        );
      })}
    </Stack>
  );
}

type Props = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  parentIndex: number;
  form: UseFormReturn<any>; //eslint-disable-line
  onLoading?: (loading: boolean) => void;
};

function FileItem({ type, parentIndex, index, modelType, onRemoveClick }: FileItemProps) {
  const [uploading, setUploading] = useState(false);

  return (
    <InputFileUpload
      label={`${splitUppercase(index > 0 ? type : modelType)} File`}
      name={`modelVersions.${parentIndex}.files.${index}`}
      placeholder="Pick a file"
      uploadType={type}
      accept={mapFileTypeAcceptedFileType[type]}
      onLoading={setUploading}
      extra={
        <Group spacing={8}>
          {index !== 0 && (
            <PopConfirm
              message="Are you sure you want to remove this file?"
              position="bottom-end"
              onConfirm={() => onRemoveClick(index)}
              withArrow
            >
              <ActionIcon color="red" size="lg" variant="outline" disabled={uploading}>
                <IconTrash size={16} stroke={1.5} />
              </ActionIcon>
            </PopConfirm>
          )}
        </Group>
      }
      grow
    />
  );
}

type FileItemProps = ModelFileInput & {
  index: number;
  parentIndex: number;
  onRemoveClick: (index: number) => void;
  modelType: ModelType;
  onLoading?: (index: number, loading: boolean) => void;
};
