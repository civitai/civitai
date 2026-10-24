import type { ImageGenStepTemplate } from '@civitai/orchestration-client';
import type { Krea3ImageGenInput } from '@civitai/orchestration-client';
import { removeEmpty } from '~/utils/object-helpers';
import { defineHandler } from '../handlers/handler-factory';
import type { EcosystemData } from './types';

type Krea3AspectRatio = NonNullable<Krea3ImageGenInput['aspectRatio']>;
// The client's union predates Ultra ('instant' | 'medium'); the orchestrator is what accepts 'ultra'.
type Krea3ThinkingMode = Krea3ImageGenInput['thinkingMode'];

export const createKrea3Input = defineHandler<EcosystemData<'Krea3'>, [ImageGenStepTemplate]>(
  (data) => [
    {
      $type: 'imageGen',
      input: {
        ...removeEmpty({
          engine: 'krea3' as const,
          prompt: data.prompt ?? '',
          quantity: data.quantity ?? 1,
          resolution: data.resolution,
          thinkingMode: data.thinkingMode as Krea3ThinkingMode,
          aspectRatio: data.aspectRatio?.value as Krea3AspectRatio | undefined,
        }),
        // Required even for text-to-image, where it is empty.
        images: data.images?.map((x) => x.url) ?? [],
      } as Krea3ImageGenInput,
    },
  ]
);
