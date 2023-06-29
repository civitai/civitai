import { ModelType } from '@prisma/client';
import { useGenerationResourceStore } from './useGenerationResourceStore';
import React from 'react';
import { Button } from '@mantine/core';
import { openContextModal } from '@mantine/modals';

export function AddGenerationResourceButton({
  types,
  limit,
  label,
}: {
  types: ModelType[];
  limit: number;
  label: string;
}) {
  const dictionary = useGenerationResourceStore((state) => state.resources);
  const addResource = useGenerationResourceStore((state) => state.addResource);
  const resources = Object.values(dictionary).flatMap((x) => x);
  const ids = resources.filter((x) => types.includes(x.modelType)).map((x) => x.id);
  const count = ids.length;

  const handleClick = () =>
    openContextModal({
      modal: 'generationResourceModal',
      title: label,
      zIndex: 400,
      innerProps: {
        notIds: ids,
        baseModel: resources[0]?.baseModel,
        onSelect: addResource,
        types,
      },
    });

  return count < limit ? (
    <Button onClick={handleClick} variant="outline" size="xs" fullWidth>
      {label}
    </Button>
  ) : null;
}
