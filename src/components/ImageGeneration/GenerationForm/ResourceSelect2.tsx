import { Button, Input, InputWrapperProps, Stack } from '@mantine/core';
import { ModelType } from '@prisma/client';
import { IconPlus } from '@tabler/icons-react';
import React from 'react';
import { Generation } from '~/server/services/generation/generation.types';

type SelectableResource = {
  type: ModelType;
  label?: React.ReactNode;
  info?: React.ReactNode;
  error?: string;
};

export function ResourceSelect<T extends boolean = false>({
  multiple,
  limit,
  value,
  onChange,
  baseModels,
  resources,
  buttonLabel,
  error,
}: {
  multiple?: T;
  limit?: number;
  value?: T extends true ? Generation.Resource[] : Generation.Resource;
  onChange?: (value?: T extends true ? Generation.Resource[] : Generation.Resource) => void;
  baseModels?: string[];
  resources: SelectableResource[];
  buttonLabel: React.ReactNode;
  error?: string;
}) {
  const _limit = multiple ? limit : 1;
  const _values = ([] as Generation.Resource[]).concat(value ?? []);
  const canAdd = !_limit || _limit >= _values.length;

  const handleAdd = (resource: Generation.Resource) => {
    if (!canAdd) return;
    const emitValue = (multiple ? [..._values, resource] : resource) as T extends true
      ? Generation.Resource[]
      : Generation.Resource;
    onChange?.(emitValue);
  };

  const handleRemove = (id: number) => {
    const filtered = multiple ? [..._values.filter((x) => x.id !== id)] : [];
    const emitValue = !!filtered.length
      ? (filtered as T extends true ? Generation.Resource[] : Generation.Resource)
      : undefined;
    onChange?.(emitValue);
  };

  const handleUpdate = (resource: Generation.Resource) => {
    const index = _values.findIndex((x) => x.id === resource.id);
    if (index > -1) {
      const emitValue = [..._values].splice(index, 1) as T extends true
        ? Generation.Resource[]
        : Generation.Resource;
      onChange?.(emitValue);
    }
  };

  const _groups = resources.map((group) => ({
    ...group,
    resources: _values.filter((x) => x.modelType === group.type),
  }));

  return (
    <Stack>
      {_groups.map((group) => {
        return (
          <Input.Wrapper key={group.type}>
            <Stack></Stack>
          </Input.Wrapper>
        );
      })}
      {canAdd && <Button leftIcon={<IconPlus />}>{buttonLabel}</Button>}
    </Stack>
  );
}
