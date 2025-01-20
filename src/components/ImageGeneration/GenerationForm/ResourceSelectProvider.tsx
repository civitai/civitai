import type { GenerationResource } from '~/server/services/generation/generation.service';
import { ModelType } from '~/shared/utils/prisma/enums';

export function ResourceSelectProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: GenerationResource[];
}) {
  const data = value.reduce<Partial<Record<ModelType, GenerationResource[]>>>((acc, resource) => {
    const type = resource.model.type;
    acc[type] = [...(acc[type] ?? []), resource];
    return acc;
  }, {});

  return <>{children}</>;
}
