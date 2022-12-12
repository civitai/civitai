import { ActionIcon, Box, Button, Group, Input, Stack, Tooltip } from '@mantine/core';
import { ModelFileType } from '@prisma/client';
import { IconPlus, IconStar, IconTrash } from '@tabler/icons';
import { startCase } from 'lodash';
import { Control, useFieldArray } from 'react-hook-form';

import { InputFileUpload, InputSelect } from '~/libs/form';

export function ModelFileFormItem<TControl extends Control<any>>({
  parentIndex,
  control,
}: Props<TControl>) {
  const { fields, append, remove } = useFieldArray({
    control,
    name: `modelVersions.${parentIndex}.files`,
  });

  return (
    <Stack>
      <Input.Wrapper
        styles={{ label: { width: '100%' } }}
        label={
          <Group position="apart">
            <Input.Label required>Model Files</Input.Label>
            <Box />
            <Button
              size="xs"
              leftIcon={<IconPlus size={16} />}
              variant="outline"
              onClick={() => append({ type: ModelFileType.Model, url: '', name: '', sizeKb: 0 })}
              compact
            >
              Add File
            </Button>
          </Group>
        }
        description="Add multiple files for this version"
      >
        {fields.map((file, index) => {
          console.log(index, control._formValues);

          return (
            <Group key={file.id} my={5} spacing={8}>
              <InputSelect
                name={`modelVersions.${parentIndex}.files.${index}.type`}
                data={Object.values(ModelFileType).map((type) => ({
                  label: startCase(type),
                  value: type,
                }))}
              />
              <InputFileUpload
                name={`modelVersions.${parentIndex}.files.${index}`}
                placeholder="Pick a file"
                uploadType="Model"
                accept=".ckpt,.pt,.safetensors"
                grow
              />
              <Tooltip label="Mark as primary">
                <ActionIcon size="xs">
                  <IconStar />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Remove file">
                <ActionIcon
                  size="xs"
                  color="red"
                  onClick={() => remove(index)}
                  sx={{ visibility: index > 0 ? 'visible' : 'hidden' }}
                >
                  <IconTrash />
                </ActionIcon>
              </Tooltip>
            </Group>
          );
        })}
      </Input.Wrapper>
    </Stack>
  );
}

type Props<TControl extends Control<any>> = { parentIndex: number; control: TControl };
