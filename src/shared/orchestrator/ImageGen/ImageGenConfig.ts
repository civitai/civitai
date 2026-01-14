import type { ImageGenInput } from '@civitai/client';
import { maxRandomSeed } from '~/server/common/constants';
import type { GenerateImageSchema } from '~/server/schema/orchestrator/textToImage.schema';
import { WORKFLOW_TAGS, getProcessTagFromWorkflow } from '~/shared/constants/generation.constants';
import { removeEmpty } from '~/utils/object-helpers';
import { isDefined } from '~/utils/type-guards';

export function ImageGenConfig<
  TMetadataParams extends { process: string; engine: string; baseModel: string; quantity: number },
  TOutput extends ImageGenInput = ImageGenInput
>({
  metadataFn,
  inputFn,
}: {
  metadataFn: (
    params: Omit<GenerateImageSchema['params'], 'priority'>,
    resources: GenerateImageSchema['resources']
  ) => TMetadataParams;
  inputFn: (args: Omit<GenerateImageSchema, 'params'> & { params: TMetadataParams }) => TOutput;
}) {
  function getParamsMetadata({
    params,
    resources,
  }: {
    params: GenerateImageSchema['params'];
    resources: GenerateImageSchema['resources'];
  }) {
    const { priority, ...rest } = params;
    const seed =
      !('seed' in rest) || !rest.seed ? Math.floor(Math.random() * maxRandomSeed) : rest.seed;
    return metadataFn({ ...rest, seed }, resources);
  }

  function getImageMetadata(args: GenerateImageSchema) {
    return JSON.stringify(
      removeEmpty({
        ...getParamsMetadata(args),
        resources: args.resources.map(({ id, strength }) => ({
          modelVersionId: id,
          strength: strength,
        })),
        remixOfId: args.remixOfId,
      })
    );
  }

  function getStepMetadata(args: GenerateImageSchema) {
    return removeEmpty({
      resources: args.resources,
      params: removeEmpty(getParamsMetadata(args)),
      remixOfId: args.remixOfId,
    });
  }

  function getStepInput(args: GenerateImageSchema) {
    const params = getParamsMetadata(args);
    const result = inputFn({ ...args, params });
    const seed =
      !('seed' in result) || !result.seed ? Math.floor(Math.random() * maxRandomSeed) : result.seed;

    return { ...result, seed };
  }

  function getTags(args: GenerateImageSchema) {
    const params = getParamsMetadata(args);
    const hasSourceImage = !!args.params.sourceImage;
    const processTag = getProcessTagFromWorkflow(params.engine, hasSourceImage, 'image');
    return [
      WORKFLOW_TAGS.GENERATION,
      WORKFLOW_TAGS.IMAGE,
      params.engine,
      params.baseModel,
      params.process,
      processTag,
      ...args.tags,
    ].filter(isDefined);
  }

  return {
    getImageMetadata,
    getStepMetadata,
    getStepInput,
    getTags,
  };
}
