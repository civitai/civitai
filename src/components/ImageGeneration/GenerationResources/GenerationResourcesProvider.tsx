import { ModelType } from '.prisma/client';
import React from 'react';
import { useGenerationResourceStore } from '~/components/ImageGeneration/GenerationResources/useGenerationResourceStore';
import { Generation } from '~/server/services/generation/generation.types';

export function GenerationResourcesProvider({
  types,
  limit,
  resources,
  children,
}: {
  types: ModelType[];
  limit: number;
  resources: Generation.Resource[];
  children: (props: {
    canAdd: boolean;
    append: (resource: Generation.Resource) => void;
  }) => React.ReactNode;
}) {
  const addResource = useGenerationResourceStore((state) => state.addResource);

  return <>{children({ canAdd: true, append: addResource })}</>;
}
