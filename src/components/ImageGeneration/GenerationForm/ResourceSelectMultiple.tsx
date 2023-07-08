import { Button, Input, InputWrapperProps, Stack } from '@mantine/core';
import { ModelType } from '@prisma/client';
import { IconPlus } from '@tabler/icons-react';
import React from 'react';
import { ResourceSelectCard } from '~/components/ImageGeneration/GenerationForm/ResourceSelectCard';
import { openResourceSelectModal } from '~/components/ImageGeneration/GenerationForm/ResourceSelectModal';
import { withController } from '~/libs/form/hoc/withController';
import { Generation } from '~/server/services/generation/generation.types';

type ResourceGrouping = {
  type: ModelType;
  label?: React.ReactNode;
  error?: string;
};

function ResourceSelectMultiple({
  limit,
  value,
  onChange,
  baseModels,
  groups,
  buttonLabel,
  ...inputWrapperProps
}: {
  limit?: number;
  value?: Generation.Resource[];
  onChange?: (value?: Generation.Resource[]) => void;
  baseModels?: string[];
  groups: ResourceGrouping[];
  buttonLabel: React.ReactNode;
} & Omit<InputWrapperProps, 'children'>) {
  const supportedTypes = groups.map((x) => x.type);
  const _values = [...(value ?? [])].filter((x) => supportedTypes.includes(x.modelType));
  const canAdd = !limit || limit >= _values.length;

  const handleAdd = (resource: Generation.Resource) => {
    if (!canAdd) return;
    onChange?.([..._values, resource]);
  };

  const handleRemove = (id: number) => {
    const filtered = [..._values.filter((x) => x.id !== id)];
    const emitValue = !!filtered.length ? filtered : undefined;
    onChange?.(emitValue);
  };

  const handleUpdate = (resource: Generation.Resource) => {
    const index = _values.findIndex((x) => x.id === resource.id);
    if (index > -1) {
      const emitValue = [..._values].splice(index, 1);
      onChange?.(emitValue);
    }
  };

  const _groups = groups
    .map((group) => ({
      ...group,
      resources: _values.filter((x) => x.modelType === group.type),
    }))
    .filter((x) => !!x.resources.length);

  if (!_groups.length && !canAdd) return null;

  return (
    <Input.Wrapper {...inputWrapperProps}>
      <Stack>
        {_groups.map((group) => {
          return (
            <Input.Wrapper key={group.type} label={group.label} error={group.error}>
              <Stack>
                {group.resources.map((resource) => (
                  <ResourceSelectCard
                    key={resource.id}
                    resource={resource}
                    onUpdate={handleUpdate}
                    onRemove={handleRemove}
                  />
                ))}
              </Stack>
            </Input.Wrapper>
          );
        })}
        {canAdd && (
          <Button
            leftIcon={<IconPlus />}
            onClick={() =>
              openResourceSelectModal({
                title: buttonLabel,
                baseModel: baseModels?.[0],
                types: supportedTypes,
                onSelect: handleAdd,
                notIds: _values.map((x) => x.id),
              })
            }
          >
            {buttonLabel}
          </Button>
        )}
      </Stack>
    </Input.Wrapper>
  );
}

const InputResourceSelectMultiple = withController(ResourceSelectMultiple);
export default InputResourceSelectMultiple;
