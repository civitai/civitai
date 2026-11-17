import { AspectRatio, Badge, Box, Center, Checkbox, Loader } from '@mantine/core';
import clsx from 'clsx';
import type { MouseEvent } from 'react';
import { useMemo } from 'react';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { getStepMeta } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useGetTextToImageRequests } from '~/components/ImageGeneration/utils/generationRequestHooks';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { NoContent } from '~/components/NoContent/NoContent';
import type { SelectedImage } from '~/components/Training/Form/ImageSelectModal';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { DEFAULT_EDGE_IMAGE_WIDTH } from '~/server/common/constants';
import type { NormalizedStepMetadata } from '~/server/services/orchestrator';
import { orchestratorNsfwLevelMap } from '~/shared/constants/browsingLevel.constants';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import type { AudioBlob, ImageBlob, VideoBlob } from '~/shared/orchestrator/workflow-data';
import { createSelectionContext, createSelectionStore } from '~/store/createSelectionStore';
import { isDefined } from '~/utils/type-guards';

export type GeneratorImage = SelectedImage & {
  resources?: NormalizedStepMetadata['resources'];
};

export const generatorSelectionStore = createSelectionStore<GeneratorImage>({
  getKey: (img) => img.url,
  name: 'generator-media-select',
});

const generatorSelection = createSelectionContext<GeneratorImage>(generatorSelectionStore);
export const useGeneratorSelection = generatorSelection.useSelection;
const { useActions, useIsSelected, useRegisterOrder } = generatorSelection;

export type GeneratorMediaCandidate = {
  type: 'image' | 'video' | 'audio';
  /** Null when the orchestrator did not rate the output. */
  nsfwLevel: number | null;
  resourceIds: number[];
};

export type GeneratorEligibility = { eligible: boolean; reasons: string[] };

type GeneratorBlob = ImageBlob | VideoBlob | AudioBlob;

type PickerItem = {
  image: GeneratorBlob;
  selection: GeneratorImage;
  eligibility: GeneratorEligibility;
};

function toCandidate(image: GeneratorBlob): GeneratorMediaCandidate {
  let nsfwLevel: number | null = null;
  if (typeof image.nsfwLevel === 'number') nsfwLevel = image.nsfwLevel;
  else if (image.nsfwLevel)
    nsfwLevel = orchestratorNsfwLevelMap[String(image.nsfwLevel).toLowerCase()] ?? null;

  const resourceIds = (image.step.resources ?? [])
    .map((r) => ('id' in r && typeof r.id === 'number' ? r.id : null))
    .filter(isDefined);

  return { type: image.type, nsfwLevel, resourceIds };
}

function toGeneratorImage(image: GeneratorBlob): GeneratorImage {
  return {
    url: image.url,
    label: (image.step.params as { prompt?: string } | undefined)?.prompt ?? '',
    type: image.type === 'video' ? 'video' : 'image',
    meta: getStepMeta(image.step),
    resources: image.step.resources,
    generationWorkflowId: image.workflowId,
  };
}

export function GeneratorMediaPicker({
  getEligibility,
  gridClassName = 'grid-cols-[repeat(auto-fill,minmax(275px,1fr))]',
  maxHeight = 440,
  workflowTag = WORKFLOW_TAGS.IMAGE,
}: {
  getEligibility: (candidate: GeneratorMediaCandidate) => GeneratorEligibility;
  gridClassName?: string;
  maxHeight?: number;
  workflowTag?: string;
}) {
  const currentUser = useCurrentUser();

  const { data, isFetching, isFetchingNextPage, hasNextPage, fetchNextPage } =
    useGetTextToImageRequests(
      { tags: [workflowTag] },
      { enabled: !!currentUser, ignoreFilters: true }
    );

  const items = useMemo(
    () =>
      data
        .flatMap((wf) =>
          wf.succeededOutput.filter(
            (x): x is GeneratorBlob => x.available && x.type !== 'model3d' && x.canUse('post')
          )
        )
        .map(
          (image): PickerItem => ({
            image,
            selection: toGeneratorImage(image),
            eligibility: getEligibility(toCandidate(image)),
          })
        ),
    [data, getEligibility]
  );

  useRegisterOrder(
    'generator-media',
    useMemo(
      () => items.filter((item) => item.eligibility.eligible).map((item) => item.selection),
      [items]
    )
  );

  if (isFetching && !isFetchingNextPage) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }

  // Keep paging while there is more: a page can hold only outputs that can't be posted.
  if (items.length === 0 && !hasNextPage) {
    return <NoContent message="No generated images found. Create some images first!" />;
  }

  return (
    <Box mah={maxHeight} style={{ overflowY: 'auto' }}>
      <div className={clsx('grid gap-2 p-2', gridClassName)}>
        {items.map((item) => (
          <GeneratorImageCard
            key={`${item.image.workflowId}_${item.image.stepName}_${item.image.id}`}
            {...item}
          />
        ))}
      </div>
      {hasNextPage && (
        <InViewLoader
          loadFn={fetchNextPage}
          loadCondition={!isFetching && !isFetchingNextPage && hasNextPage}
        >
          <Center p="xl" style={{ height: 36 }}>
            <Loader />
          </Center>
        </InViewLoader>
      )}
    </Box>
  );
}

function GeneratorImageCard({ image, selection, eligibility }: PickerItem) {
  const { select } = useActions();
  const isSelected = useIsSelected(selection);

  const handleClick = (e: MouseEvent) => {
    if (!eligibility.eligible) return;
    select(selection, { shiftKey: e.shiftKey, checked: !isSelected });
  };

  return (
    <div
      className={clsx(
        'relative cursor-pointer overflow-hidden rounded-lg',
        isSelected && 'ring-2 ring-blue-5',
        !eligibility.eligible && 'cursor-not-allowed opacity-40 grayscale'
      )}
      onClick={handleClick}
    >
      <AspectRatio ratio={3 / 4}>
        <EdgeMedia
          alt="Generated image"
          src={image.url}
          type={image.type}
          width={DEFAULT_EDGE_IMAGE_WIDTH}
          className="size-full object-cover"
          anim
        />
      </AspectRatio>
      {eligibility.eligible ? (
        <Checkbox checked={isSelected} readOnly size="lg" className="absolute right-1.5 top-1.5" />
      ) : (
        <Badge
          color="red"
          variant="filled"
          size="sm"
          className="absolute right-1.5 top-1.5 max-w-[calc(100%-12px)]"
        >
          {eligibility.reasons[0]}
        </Badge>
      )}
    </div>
  );
}
