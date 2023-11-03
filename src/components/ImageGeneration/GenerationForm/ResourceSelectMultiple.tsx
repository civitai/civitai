import { Button, Input, InputWrapperProps, Stack } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import React, { forwardRef, useEffect } from 'react';
import { ResourceSelectCard } from '~/components/ImageGeneration/GenerationForm/ResourceSelectCard';
import { openResourceSelectModal } from '~/components/ImageGeneration/GenerationForm/ResourceSelectModal';
import { ResourceSelectOptions } from './resource-select.types';
import { withController } from '~/libs/form/hoc/withController';
import { Generation } from '~/server/services/generation/generation.types';
import { getDisplayName } from '~/utils/string-helpers';

type ResourceSelectMultipleProps = {
  limit?: number;
  value?: Generation.Resource[];
  onChange?: (value?: Generation.Resource[]) => void;
  buttonLabel: React.ReactNode;
  options?: ResourceSelectOptions;
} & Omit<InputWrapperProps, 'children'>;

const ResourceSelectMultiple = forwardRef<HTMLDivElement, ResourceSelectMultipleProps>(
  ({ limit, value = [], onChange, buttonLabel, options = {}, ...inputWrapperProps }, ref) => {
    const { types } = options;

    // _types used to set up groups
    const _types = types ?? [...new Set(value?.map((x) => x.modelType))];
    const _values = types ? [...value].filter((x) => types.includes(x.modelType)) : value;
    const groups = _types
      .map((type) => ({
        type,
        label: getDisplayName(type),
        resources: _values.filter((x) => x.modelType === type),
      }))
      .filter((x) => !!x.resources.length);
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
        const emitValue = [..._values];
        emitValue[index] = resource;
        onChange?.(emitValue);
      }
    };

    // removes resources that have unsupported types
    useEffect(() => {
      if (_values.length !== value.length) onChange?.(_values.length ? _values : undefined);
    }, [value]); //eslint-disable-line

    return (
      <Input.Wrapper {...inputWrapperProps} ref={ref}>
        <Stack spacing="xs">
          {groups.map((group) => {
            return (
              <Input.Wrapper key={group.type} label={group.label}>
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
                  onSelect: handleAdd,
                  notIds: _values.map((x) => x.id),
                  options,
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
