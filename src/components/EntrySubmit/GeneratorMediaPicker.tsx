import { AspectRatio, Badge, Box, Center, Checkbox, Loader } from '@mantine/core';
import clsx from 'clsx';
import { useCallback, useMemo } from 'react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
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
import { isDefined } from '~/utils/type-guards';

export type GeneratorImage = SelectedImage & {
  resources?: NormalizedStepMetadata['resources'];
};

type GeneratorSelectionState = {
  selected: GeneratorImage[];
  toggleSelected: (img: GeneratorImage) => void;
  deselectAll: () => void;
};

export const useGeneratorSelectionStore = create<GeneratorSelectionState>()(
  immer((set) => ({
    selected: [],
    toggleSelected: (img) => {
      set((state) => {
        const idx = state.selected.findIndex((s) => s.url === img.url);
        if (idx >= 0) state.selected.splice(idx, 1);
        else state.selected.push({ ...img });
      });
    },
    deselectAll: () => {
      set((state) => {
        state.selected = [];
      });
    },
  }))
);

export type GeneratorMediaCandidate = {
  type: 'image' | 'video' | 'audio';
  /** Null when the orchestrator did not rate the output. */
  nsfwLevel: number | null;
  resourceIds: number[];
};

export type GeneratorEligibility = { eligible: boolean; reasons: string[] };

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

  const generatedMedia = useMemo(
    () =>
      data.flatMap((wf) =>
        wf.succeededOutput.filter(
          (x): x is ImageBlob | VideoBlob | AudioBlob => x.available && x.type !== 'model3d'
        )
      ),
    [data]
  );

  if (isFetching && !isFetchingNextPage) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }

  if (generatedMedia.length === 0) {
    return <NoContent message="No generated images found. Create some images first!" />;
  }

  return (
    <Box mah={maxHeight} style={{ overflowY: 'auto' }}>
      <div className={clsx('grid gap-2 p-2', gridClassName)}>
        {generatedMedia.map((img) => (
          <GeneratorImageCard
            key={`${img.workflowId}_${img.stepName}_${img.id}`}
            image={img}
            getEligibility={getEligibility}
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

function GeneratorImageCard({
  image,
  getEligibility,
}: {
  image: ImageBlob | VideoBlob | AudioBlob;
  getEligibility: (candidate: GeneratorMediaCandidate) => GeneratorEligibility;
}) {
  const stepParams = image.step.params;
  const stepResources = image.step.resources;
  const toggleSelected = useGeneratorSelectionStore((state) => state.toggleSelected);
  const isSelected = useGeneratorSelectionStore(
    useCallback((state) => state.selected.some((s) => s.url === image.url), [image.url])
  );

  const eligibility = useMemo(() => {
    let nsfwLevel: number | null = null;
    if (typeof image.nsfwLevel === 'number') nsfwLevel = image.nsfwLevel;
    else if (image.nsfwLevel)
      nsfwLevel = orchestratorNsfwLevelMap[String(image.nsfwLevel).toLowerCase()] ?? null;

    const resourceIds = (stepResources ?? [])
      .map((r) => ('id' in r && typeof r.id === 'number' ? r.id : null))
      .filter(isDefined);

    return getEligibility({ type: image.type, nsfwLevel, resourceIds });
  }, [getEligibility, image.nsfwLevel, image.type, stepResources]);

  const handleClick = () => {
    if (!eligibility.eligible) return;

    toggleSelected({
      url: image.url,
      label: (stepParams as { prompt?: string } | undefined)?.prompt ?? '',
      type: image.type === 'video' ? 'video' : 'image',
      meta: getStepMeta(image.step),
      resources: stepResources,
      generationWorkflowId: image.workflowId,
    });
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
