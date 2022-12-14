import { ActionIcon, Button, Group, Input, InputWrapperProps, Stack, Tooltip } from '@mantine/core';
import { ModelFileFormat, ModelFileType } from '@prisma/client';
import { IconPlus, IconStar, IconTrash } from '@tabler/icons';
import get from 'lodash/get';
import startCase from 'lodash/startCase';
import { useState } from 'react';
import { Control, useFieldArray } from 'react-hook-form';

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

export function FileList<TControl extends Control<any>>({ parentIndex, control }: Props<TControl>) {
  const { fields, append, remove, update } = useFieldArray({
    control,
    name: `modelVersions.${parentIndex}.files`,
    rules: {
      minLength: 1,
      maxLength: fileTypeCount,
      required: true,
    },
  });

  const handlePrimaryClick = (index: number) => {
    fields.map(({ id, ...field }, i) => {
      const matchingFile: ModelFileInput = get(
        control._formValues,
        `modelVersions.${parentIndex}.files.${i}`
      );
      update(i, { ...matchingFile, ...field, primary: index === i });
    });
  };

  const handleTypeChange = (index: number, type: ModelFileInput['type']) => {
    update(index, { type, primary: false, sizeKB: 0, name: '', url: '' });
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
            {...file}
          />
        );
      })}
    </Input.Wrapper>
  );
}

type Props<TControl extends Control<any>> = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  parentIndex: number;
  control: TControl;
};

function FileItem({
  primary,
  type,
  parentIndex,
  index,
  onRemoveClick,
  onPrimaryClick,
  onTypeChange,
}: FileItemProps) {
  const [selectedType, setSelectedType] = useState<ModelFileType>(type);
  const isModelType = ['Model', 'PrunedModel'].includes(selectedType);

  return (
    <Group my={5} spacing={8}>
      <InputSelect
        name={`modelVersions.${parentIndex}.files.${index}.type`}
        data={Object.values(ModelFileType).map((type) => ({
          label: startCase(type),
          value: type,
          disabled: primary && !['Model', 'PrunedModel'].includes(type),
        }))}
        onChange={(value: ModelFileType) => {
          setSelectedType(value);
          onTypeChange(index, value);
        }}
      />
      <InputFileUpload
        name={`modelVersions.${parentIndex}.files.${index}`}
        placeholder="Pick a file"
        uploadType={type}
        accept={mapFileTypeAcceptedFileType[type]}
        grow
      />
      <Tooltip label="Mark as primary">
        <ActionIcon
          size="xs"
          onClick={!primary && isModelType ? () => onPrimaryClick(index) : undefined}
          sx={{
            visibility: isModelType ? 'visible' : 'hidden',
          }}
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
};
