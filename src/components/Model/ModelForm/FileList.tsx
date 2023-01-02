import { ActionIcon, Button, Group, Input, InputWrapperProps, Tooltip } from '@mantine/core';
import { ModelFileFormat, ModelType } from '@prisma/client';
import { IconPlus, IconStar, IconTrash } from '@tabler/icons';
import startCase from 'lodash/startCase';
import { useEffect, useState } from 'react';
import { useFieldArray, UseFormReturn } from 'react-hook-form';

import { InputFileUpload, InputSelect } from '~/libs/form';
import { constants, ModelFileType } from '~/server/common/constants';
import { ModelFileInput } from '~/server/schema/model-file.schema';

const fileFormats = Object.values(ModelFileFormat).filter((type) => type !== 'Other');
const fileFormatCount = fileFormats.length;
const mapFileTypeAcceptedFileType: Record<ModelFileType, string> = {
  Model: '.ckpt,.pt,.safetensors',
  'Pruned Model': '.ckpt,.pt,.safetensors',
  Negative: '.pt',
  'Training Data': '.zip',
  Config: '.yaml,.yml',
  VAE: '.pt,.ckpt,.safetensors',
  'Text Encoder': '.pt',
};

export function FileList({ parentIndex, form, ...wrapperProps }: Props) {
  const files = form.watch(`modelVersions.${parentIndex}.files`) as ModelFileInput[];
  const modelType = form.watch('type') as ModelType;
  const isCheckpointModel = modelType === 'Checkpoint';
  const availableFileTypes = isCheckpointModel
    ? constants.modelFileTypes
    : constants.modelFileTypes.filter((type) => type !== 'Pruned Model');
  const fileTypeCount = availableFileTypes.length;
  // We reduce by 2 when is not checkpoint cause we don't need prunedModel
  const maxLength = fileTypeCount + fileFormatCount - (isCheckpointModel ? 0 : 2);

  const { fields, append, remove, update } = useFieldArray({
    control: form.control,
    name: `modelVersions.${parentIndex}.files`,
    rules: {
      maxLength,
      minLength: 1,
      required: true,
    },
  });

  const handlePrimaryClick = (index: number) => {
    fields.map(({ id, ...field }, i) => {
      const matchingFile = files[i];
      update(i, { ...matchingFile, ...field, primary: index === i });
    });
  };

  const handleTypeChange = (index: number, type: ModelFileInput['type']) => {
    const matchingFile = files[index];
    update(index, { ...matchingFile, type, sizeKB: 0, name: '', url: '' });
  };

  // We only want to check for files that are not model or prunedModel
  // to prevented the user from selecting the same file type
  const selectedTypes = files
    .map(({ type }) => type)
    .filter((type) => !['Model', 'PrunedModel'].includes(type));

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

  return (
    <Input.Wrapper
      {...wrapperProps}
      styles={{ label: { width: '100%' } }}
      label={
        <Group position="apart">
          <Input.Label required>Model Files</Input.Label>
          <Button
            size="xs"
            leftIcon={<IconPlus size={16} />}
            variant="outline"
            onClick={() =>
              fields.length < maxLength
                ? append({
                    type: constants.modelFileTypes[0],
                    url: '',
                    name: '',
                    sizeKB: 0,
                    primary: false,
                  })
                : undefined
            }
            disabled={fields.length >= maxLength}
            compact
          >
            Add File
          </Button>
        </Group>
      }
      description={`Add multiple files for this version (${fields.length}/${maxLength})`}
    >
      {fields.map(({ id, ...item }, index) => {
        const file = item as ModelFileInput;
        return (
          <FileItem
            key={id}
            index={index}
            parentIndex={parentIndex}
            onRemoveClick={(index) => remove(index)}
            onPrimaryClick={handlePrimaryClick}
            onTypeChange={handleTypeChange}
            modelType={modelType}
            selectedTypes={selectedTypes}
            {...file}
          />
        );
      })}
    </Input.Wrapper>
  );
}

type Props = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  parentIndex: number;
  form: UseFormReturn<any>; //eslint-disable-line
  onLoading?: (loading: boolean) => void;
};

const fileTypesByModelType: Record<ModelType, ModelFileType[]> = {
  TextualInversion: ['Model', 'Negative', 'Training Data'],
  LORA: ['Model', 'Text Encoder', 'Training Data'],
  Checkpoint: ['Model', 'Pruned Model', 'Config', 'VAE', 'Training Data'],
  AestheticGradient: ['Model', 'Training Data'],
  Hypernetwork: ['Model', 'Training Data'],
};

function FileItem({
  primary,
  type,
  parentIndex,
  index,
  modelType,
  selectedTypes,
  onRemoveClick,
  onPrimaryClick,
  onTypeChange,
}: FileItemProps) {
  const [selectedType, setSelectedType] = useState<ModelFileType>(type);
  const [uploading, setUploading] = useState(false);
  const isModelType = ['Model', 'PrunedModel'].includes(selectedType);
  const isCheckpointModel = modelType === 'Checkpoint';
  const fileTypeOptions = fileTypesByModelType[modelType];

  return (
    <Group my={5} spacing={8} noWrap>
      <InputSelect
        name={`modelVersions.${parentIndex}.files.${index}.type`}
        data={fileTypeOptions.map((type) => ({
          label: type === 'Model' && !isCheckpointModel ? startCase(modelType) : startCase(type),
          value: type,
          disabled:
            (primary && !['Model', 'Pruned Model'].includes(type)) || selectedTypes.includes(type),
        }))}
        onChange={(value: ModelFileType) => {
          setSelectedType(value);
          onTypeChange(index, value);
        }}
        disabled={uploading}
      />
      <InputFileUpload
        name={`modelVersions.${parentIndex}.files.${index}`}
        placeholder="Pick a file"
        uploadType={type}
        accept={mapFileTypeAcceptedFileType[type]}
        onLoading={setUploading}
        grow
        stackUploadProgress
      />
      <Tooltip label="Mark as primary">
        <ActionIcon
          size="xs"
          onClick={!primary && isModelType ? () => onPrimaryClick(index) : undefined}
          sx={{
            visibility: isModelType ? 'visible' : 'hidden',
          }}
          disabled={uploading}
        >
          <IconStar
            color={primary ? 'gold' : undefined}
            style={{ fill: primary ? 'gold' : undefined }}
          />
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Remove file">
        <ActionIcon
          size="xs"
          color="red"
          onClick={() => onRemoveClick(index)}
          sx={{ visibility: !primary ? 'visible' : 'hidden' }}
          disabled={uploading}
        >
          <IconTrash />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

type FileItemProps = ModelFileInput & {
  index: number;
  parentIndex: number;
  onRemoveClick: (index: number) => void;
  onPrimaryClick: (index: number) => void;
  onTypeChange: (index: number, type: ModelFileType) => void;
  modelType: ModelType;
  selectedTypes: ModelFileType[];
  onLoading?: (index: number, loading: boolean) => void;
};
