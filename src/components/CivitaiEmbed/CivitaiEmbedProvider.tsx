import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  BrowsingLevelProvider,
  ViewerBrowsingLevelScope,
} from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useQueryImages } from '~/components/Image/image.utils';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import type { UseQueryModelReturn } from '~/components/Model/model.utils';
import { useQueryModels } from '~/components/Model/model.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import type { CivitaiEmbedType } from '~/shared/tiptap/civitai-embed.utils';

export type EmbedModel = UseQueryModelReturn[number];
export type EmbedImage = ImagesInfiniteModel;

type Result<T> = { loaded: boolean; failed?: boolean; byId: Map<number, T> };
const pending = <T,>(): Result<T> => ({ loaded: false, byId: new Map() });

type EmbedState = {
  requestLoad: () => void;
  canEnableMature: boolean;
  models: Result<EmbedModel>;
  images: Result<EmbedImage>;
  /** Missing at the viewer's level but present at the most this domain lets them enable. */
  matureModels: Result<EmbedModel>;
  matureImages: Result<EmbedImage>;
};

const CivitaiEmbedContext = createContext<EmbedState | null>(null);

export function useCivitaiEmbedContext() {
  return useContext(CivitaiEmbedContext);
}

type FetcherProps<T> = { ids: number[]; enabled: boolean; onResult: (result: Result<T>) => void };

function useReport<T extends { id: number }>(
  items: T[] | undefined,
  query: { enabled: boolean; isLoading: boolean; isFetched: boolean; isError: boolean },
  onResult: (result: Result<T>) => void
) {
  const { enabled, isLoading, isFetched, isError } = query;
  const settled = enabled && (isError || (isFetched && !isLoading));
  useEffect(() => {
    if (!settled) return;
    // A failed request says nothing about any id, so it must not read as "missing" and send
    // every embed to the mature follow-up.
    if (isError) onResult({ loaded: true, failed: true, byId: new Map() });
    else onResult({ loaded: true, byId: new Map((items ?? []).map((x) => [x.id, x])) });
  }, [items, settled, isError]); // eslint-disable-line react-hooks/exhaustive-deps
}

function ModelFetcher({ ids, enabled, onResult }: FetcherProps<EmbedModel>) {
  const { models, isLoading, isFetched, isError } = useQueryModels(
    { ids, limit: ids.length },
    { enabled }
  );
  useReport(models, { enabled, isLoading, isFetched, isError }, onResult);
  return null;
}

function ImageFetcher({ ids, enabled, onResult }: FetcherProps<EmbedImage>) {
  const { images, isLoading, isFetched, isError } = useQueryImages(
    { ids, limit: ids.length },
    { enabled }
  );
  useReport(images, { enabled, isLoading, isFetched, isError }, onResult);
  return null;
}

const missing = <T,>(ids: number[], result: Result<T>) =>
  result.loaded && !result.failed ? ids.filter((id) => !result.byId.has(id)) : [];

/**
 * One feed query per type for every embed on the page, sent once the first card scrolls into
 * view. Ids the viewer's level drops get one follow-up at the widest level the domain lets this
 * viewer enable, only to tell "mature" from "gone"; that data stays out of the DOM until Show.
 */
export function CivitaiEmbedProvider({
  modelIds,
  imageIds,
  children,
}: {
  modelIds: number[];
  imageIds: number[];
  children: ReactNode;
}) {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const canEnableMature = !!features.canViewNsfw && !!currentUser;

  const [requested, setRequested] = useState(false);
  const [models, setModels] = useState(pending<EmbedModel>);
  const [images, setImages] = useState(pending<EmbedImage>);
  const [matureModels, setMatureModels] = useState(pending<EmbedModel>);
  const [matureImages, setMatureImages] = useState(pending<EmbedImage>);

  const missingModelIds = useMemo(() => missing(modelIds, models), [modelIds, models]);
  const missingImageIds = useMemo(() => missing(imageIds, images), [imageIds, images]);

  const requestLoad = useCallback(() => setRequested(true), []);
  const value = useMemo(
    () => ({ requestLoad, canEnableMature, models, images, matureModels, matureImages }),
    [requestLoad, canEnableMature, models, images, matureModels, matureImages]
  );

  return (
    <CivitaiEmbedContext.Provider value={value}>
      <ViewerBrowsingLevelScope>
        <ModelFetcher
          ids={modelIds}
          enabled={requested && !!modelIds.length}
          onResult={setModels}
        />
        <ImageFetcher
          ids={imageIds}
          enabled={requested && !!imageIds.length}
          onResult={setImages}
        />
        {canEnableMature && (
          <BrowsingLevelProvider browsingLevel={allBrowsingLevelsFlag}>
            <ModelFetcher
              ids={missingModelIds}
              enabled={!!missingModelIds.length}
              onResult={setMatureModels}
            />
            <ImageFetcher
              ids={missingImageIds}
              enabled={!!missingImageIds.length}
              onResult={setMatureImages}
            />
          </BrowsingLevelProvider>
        )}
        <ImagesProvider images={[...images.byId.values()]} hideHatTurf hideStickerBadge>
          {children}
        </ImagesProvider>
      </ViewerBrowsingLevelScope>
    </CivitaiEmbedContext.Provider>
  );
}

export type EmbedView<T> =
  | { state: 'loading' }
  | { state: 'card'; data: T }
  | { state: 'mature'; data: T }
  | { state: 'unavailable' };

export function resolveEmbedView<T>(
  id: number,
  result: Result<T>,
  mature: Result<T>,
  canEnableMature: boolean
): EmbedView<T> {
  if (!result.loaded) return { state: 'loading' };
  const data = result.byId.get(id);
  if (data) return { state: 'card', data };
  if (result.failed || !canEnableMature) return { state: 'unavailable' };
  if (!mature.loaded) return { state: 'loading' };
  const matureData = mature.byId.get(id);
  return matureData ? { state: 'mature', data: matureData } : { state: 'unavailable' };
}

export type EmbedItemView =
  | ({ type: 'model' } & EmbedView<EmbedModel>)
  | ({ type: 'image' } & EmbedView<EmbedImage>);

export function useEmbedView(type: CivitaiEmbedType, id: number): EmbedItemView {
  const ctx = useCivitaiEmbedContext();
  if (!ctx) return { type, state: 'unavailable' };
  return type === 'model'
    ? { type, ...resolveEmbedView(id, ctx.models, ctx.matureModels, ctx.canEnableMature) }
    : { type, ...resolveEmbedView(id, ctx.images, ctx.matureImages, ctx.canEnableMature) };
}
