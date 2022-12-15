import { ActionIcon, Button, Group, Input, InputWrapperProps, Tooltip } from '@mantine/core';
import { ModelFileFormat, ModelFileType, ModelType } from '@prisma/client';
import { IconPlus, IconStar, IconTrash } from '@tabler/icons';
import startCase from 'lodash/startCase';
import { useState } from 'react';
import { useFieldArray, UseFormReturn } from 'react-hook-form';

import { InputFileUpload, InputSelect } from '~/libs/form';
import { ModelFileInput } from '~/server/schema/model-file.schema';

const fileTypeCount = Object.values(ModelFileType).length + Object.values(ModelFileFormat).length;
const mapFileTypeAcceptedFileType: Record<ModelFileType, string> = {
  Model: '.ckpt,.pt,.safetensors',
  PrunedModel: '.ckpt,.pt,.safetensors',
  TrainingData: '.zip',
  Config: '.yaml,.yml',
  VAE: '.pt',
};

export function FileList({ parentIndex, form }: Props) {
  const { fields, append, remove, update } = useFieldArray({
    control: form.control,
    name: `modelVersions.${parentIndex}.files`,
    rules: {
      minLength: 1,
      maxLength: fileTypeCount,
      required: true,
    },
  });

  const files = form.watch(`modelVersions.${parentIndex}.files`) as ModelFileInput[];
  const modelType = form.watch('type') as ModelType;

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

  return (
    <Input.Wrapper
      styles={{ label: { width: '100%' } }}
      label={
        <Group position="apart">
          <Input.Label required>Model Files</Input.Label>
          <Button
            size="xs"
            leftIcon={<IconPlus size={16} />}
            variant="outline"
            onClick={() =>
              fields.length < fileTypeCount
                ? append({
                    type: ModelFileType.Model,
                    url: '',
                    name: '',
                    sizeKB: 0,
                    primary: false,
                  })
                : undefined
            }
            disabled={fields.length >= fileTypeCount}
            compact
          >
            Add File
          </Button>
        </Group>
      }
      description="Add multiple files for this version"
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
            {...file}
          />
        );
      })}
    </Input.Wrapper>
  );
}

type Props = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  parentIndex: number;
  form: UseFormReturn<any>;
  onLoading?: (loading: boolean) => void;
};

function FileItem({
  primary,
  type,
  parentIndex,
  index,
  modelType,
  onRemoveClick,
  onPrimaryClick,
  onTypeChange,
}: FileItemProps) {
  const [selectedType, setSelectedType] = useState<ModelFileType>(type);
  const [uploading, setUploading] = useState(false);
  const isModelType = ['Model', 'PrunedModel'].includes(selectedType);
  const isCheckpointModel = modelType === 'Checkpoint';

  return (
    <Group my={5} spacing={8} noWrap>
      <InputSelect
        name={`modelVersions.${parentIndex}.files.${index}.type`}
        data={Object.values(ModelFileType)
          .filter((type) => (!isCheckpointModel ? type !== 'PrunedModel' : true))
          .map((type) => ({
            label: type === 'Model' && !isCheckpointModel ? startCase(modelType) : startCase(type),
            value: type,
            disabled: primary && !['Model', 'PrunedModel'].includes(type),
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
  onLoading?: (index: number, loading: boolean) => void;
};
