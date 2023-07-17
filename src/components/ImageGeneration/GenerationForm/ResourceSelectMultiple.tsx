import { Button, Card, Input, InputWrapperProps, Stack } from '@mantine/core';
import { ModelType } from '@prisma/client';
import { IconPlus } from '@tabler/icons-react';
import React, { forwardRef, useEffect } from 'react';
import { useBaseModelsContext } from '~/components/ImageGeneration/GenerationForm/BaseModelProvider';
import { ResourceSelectCard } from '~/components/ImageGeneration/GenerationForm/ResourceSelectCard';
import { openResourceSelectModal } from '~/components/ImageGeneration/GenerationForm/ResourceSelectModal';
import { withController } from '~/libs/form/hoc/withController';
import { Generation } from '~/server/services/generation/generation.types';

type ResourceGrouping = {
  type: ModelType;
  label?: React.ReactNode;
  error?: string;
};

type ResourceSelectMultipleProps = {
  limit?: number;
  value?: Generation.Resource[];
  onChange?: (value?: Generation.Resource[]) => void;
  groups: ResourceGrouping[];
  buttonLabel: React.ReactNode;
} & Omit<InputWrapperProps, 'children'>;

const ResourceSelectMultiple = forwardRef<HTMLDivElement, ResourceSelectMultipleProps>(
  ({ limit, value = [], onChange, groups, buttonLabel, ...inputWrapperProps }, ref) => {
    const supportedTypes = groups.map((x) => x.type);
    const _values = [...value].filter((x) => supportedTypes.includes(x.modelType));
    const canAdd = !limit || limit >= _values.length;

    console.log({ value });

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
        const emitValue = [..._values];
        emitValue[index] = resource;
        onChange?.(emitValue);
      }
    };

    const _groups = groups
      .map((group) => ({
        ...group,
        resources: _values.filter((x) => x.modelType === group.type),
      }))
      .filter((x) => !!x.resources.length);

    const { baseModels } = useBaseModelsContext();

    // removes resources that have unsupported types
    useEffect(() => {
      const filtered = value.filter((x) => supportedTypes.includes(x.modelType));
      if (filtered.length !== value.length) onChange?.(filtered.length ? filtered : undefined);
    }, [value]); //eslint-disable-line

    if (!_groups.length && !canAdd) return null;

    return (
      <Input.Wrapper {...inputWrapperProps}>
        <Stack spacing="xs">
          {_groups.map((group) => {
            return (
              <Input.Wrapper key={group.type} label={group.label} error={group.error}>
                <Stack spacing={4}>
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
              variant="default"
              leftIcon={<IconPlus size={18} />}
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
);

ResourceSelectMultiple.displayName = 'ResourceSelectMultiple';

const InputResourceSelectMultiple = withController(ResourceSelectMultiple, ({ field }) => ({
  value: field.value,
}));
export default InputResourceSelectMultiple;
