import { ModelType } from '@prisma/client';
import { useCallback } from 'react';
import { useGenerationResourceStore } from '~/components/ImageGeneration/GenerationResources/useGenerationResourceStore';

export function GenerationResourceControl({
  type,
  children,
}: {
  type: ModelType;
  children: (args: {
    errors: string[] | undefined;
    count: number;
    type: ModelType;
  }) => React.ReactNode;
}) {
  const resources = useGenerationResourceStore(
    useCallback((state) => state.resources[type], [type])
  );
  const errors = useGenerationResourceStore(useCallback((state) => state.errors[type], [type]));
  const count = resources.length;

  return <>{children({ errors, count, type })}</>;
}
