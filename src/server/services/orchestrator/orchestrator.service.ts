import { env } from '~/env/server';
import { VideoGenerationSchema } from '~/server/orchestrator/generation/generation.config';
import { GenerationSchema } from '~/server/orchestrator/generation/generation.schema';
import { GenerationPriorityLevelMap } from '~/server/orchestrator/infrastructure/base.enums';
import { removeEmpty } from '~/utils/object-helpers';

export async function createWorkflowStep(args: GenerationSchema) {
  switch (args.type) {
    case 'image':
      throw new Error('unsupported generation workflow step type: "image"');
    case 'video':
      return await createVideoGenStep(args.data);
  }
}

export async function createVideoGenStep({ priority, ...data }: VideoGenerationSchema) {
  return {
    $type: 'videoGen' as const,
    priority,
    input: data,
    metadata: { params: removeEmpty(data) },
  };
}

type PriorityVolumeQueryResult = Record<
  string,
  {
    prioritySummaries: Record<string, PrioritySummary>;
  }
>;

type PrioritySummary = {
  size: number;
  cost: number;
  active: number;
  throughputRate: number;
  lag: string;
  normalizedLag: string;
  drainTime: string;
};

const defaultGenerationPriorityValues = Object.values(GenerationPriorityLevelMap).reduce<
  Record<string, number>
>((acc, key) => ({ ...acc, [key]: 0 }), {});
export async function getPriorityVolume() {
  const token = env.ORCHESTRATOR_ACCESS_TOKEN;
  const response = await fetch('https://orchestration.civitai.com/v1/producer', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error);
  }
  const data = (await response.json()) as PriorityVolumeQueryResult;

  return Object.entries(data).map(([key, value]) => {
    return {
      key,
      prioritySummaries: Object.entries(value.prioritySummaries).reduce<Record<string, number>>(
        (acc, [key, value]) => ({ ...acc, [key]: value.size }),
        defaultGenerationPriorityValues
      ),
    };
  });
}
