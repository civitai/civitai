import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  BrowsingLevelProvider,
  useBrowsingLevelDebounced,
  ViewerBrowsingLevelScope,
} from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useQueryImages } from '~/components/Image/image.utils';
import { ImagesProvider } from '~/components/Image/Providers/ImagesProvider';
import type { UseQueryModelReturn } from '~/components/Model/model.utils';
import { useQueryModels } from '~/components/Model/model.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { EmbedAvailability } from '~/server/controllers/civitai-embed.controller';
import type { ImagesInfiniteModel } from '~/server/services/image.service';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import type { CivitaiEmbedType } from '~/shared/tiptap/civitai-embed.utils';
import { trpc } from '~/utils/trpc';

export type EmbedModel = UseQueryModelReturn[number];
export type EmbedImage = ImagesInfiniteModel;

type Result<T> = { loaded: boolean; failed?: boolean; byId: Map<number, T> };
const pending = <T,>(): Result<T> => ({ loaded: false, byId: new Map() });
const none: Result<EmbedAvailability> = { loaded: true, byId: new Map() };

type EmbedState = {
  requestLoad: () => void;
  canEnableMature: boolean;
  models: Result<EmbedModel>;
  images: Result<EmbedImage>;
  matureModels: Result<EmbedModel>;
  matureImages: Result<EmbedImage>;
  hiddenModels: Result<EmbedAvailability>;
  hiddenImages: Result<EmbedAvailability>;
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

/** Only whether each id is public and above this viewer's level; no field of the item. */
function HiddenFetcher({
  modelIds,
  imageIds,
  enabled,
  onModels,
  onImages,
}: {
  modelIds: number[];
  imageIds: number[];
  enabled: boolean;
  onModels: (result: Result<EmbedAvailability>) => void;
  onImages: (result: Result<EmbedAvailability>) => void;
}) {
  const browsingLevel = useBrowsingLevelDebounced();
  const { data, isLoading, isFetched, isError } = trpc.content.getEmbedAvailability.useQuery(
    { modelIds, imageIds, browsingLevel },
    { enabled }
  );
  // A new key (level or ids changed) must not keep answering from the old one meanwhile.
  const key = `${browsingLevel}:${modelIds}:${imageIds}`;
  useEffect(() => {
    onModels(pending());
    onImages(pending());
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const models = useMemo(() => data?.models.filter((x) => x.aboveViewerLevel), [data]);
  const images = useMemo(() => data?.images.filter((x) => x.aboveViewerLevel), [data]);
  const query = { enabled, isLoading, isFetched, isError };
  useReport(models, query, onModels);
  useReport(images, query, onImages);
  return null;
}

const missing = <T,>(ids: number[], result: Result<T>) =>
  result.loaded && !result.failed ? ids.filter((id) => !result.byId.has(id)) : [];

/**
 * Ids the viewer's level drops get one follow-up at the domain's widest level, to tell
 * "mature" from "gone"; that data stays out of the DOM until Show. With mature content off
 * no item above their level is requested at all: showNsfw is the over-18 confirmation, and a
 * response is a disclosure whether or not it renders. Those viewers get only a yes/no per id
 * from getEmbedAvailability, and signed out not even that: their cap is PG, so it is always no.
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
  const showNsfw = useBrowsingSettings((x) => x.showNsfw);
  const canEnableMature = !!features.canViewNsfw && !!currentUser && showNsfw;
  const checkHidden = !canEnableMature && !!currentUser;

  const [requested, setRequested] = useState(false);
  const [models, setModels] = useState(pending<EmbedModel>);
  const [images, setImages] = useState(pending<EmbedImage>);
  const [matureModels, setMatureModels] = useState(pending<EmbedModel>);
  const [matureImages, setMatureImages] = useState(pending<EmbedImage>);
  const [hiddenModels, setHiddenModels] = useState(pending<EmbedAvailability>);
  const [hiddenImages, setHiddenImages] = useState(pending<EmbedAvailability>);

  const missingModelIds = useMemo(() => missing(modelIds, models), [modelIds, models]);
  const missingImageIds = useMemo(() => missing(imageIds, images), [imageIds, images]);

  // Viewer-level images only: this list is also the detail modal's prev/next, which must not
  // step onto a mature image the reader has not chosen to show.
  const feedImages = useMemo(() => [...images.byId.values()], [images]);

  const requestLoad = useCallback(() => setRequested(true), []);
  const value = useMemo(
    () => ({
      requestLoad,
      canEnableMature,
      models,
      images,
      matureModels,
      matureImages,
      hiddenModels: checkHidden && missingModelIds.length ? hiddenModels : none,
      hiddenImages: checkHidden && missingImageIds.length ? hiddenImages : none,
    }),
    [
      requestLoad,
      canEnableMature,
      models,
      images,
      matureModels,
      matureImages,
      checkHidden,
      missingModelIds,
      missingImageIds,
      hiddenModels,
      hiddenImages,
    ]
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
        {checkHidden && (
          <HiddenFetcher
            modelIds={missingModelIds}
            imageIds={missingImageIds}
            enabled={!!(missingModelIds.length || missingImageIds.length)}
            onModels={setHiddenModels}
            onImages={setHiddenImages}
          />
        )}
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
        <ImagesProvider images={feedImages} hideHatTurf hideStickerBadge>
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
  | { state: 'hidden' }
  | { state: 'unavailable' };

export function resolveEmbedView<T>(
  id: number,
  result: Result<T>,
  mature: Result<T>,
  canEnableMature: boolean,
  hidden: Result<EmbedAvailability>
): EmbedView<T> {
  if (!result.loaded) return { state: 'loading' };
  const data = result.byId.get(id);
  if (data) return { state: 'card', data };
  if (result.failed) return { state: 'unavailable' };
  if (!canEnableMature) {
    if (!hidden.loaded) return { state: 'loading' };
    return hidden.byId.has(id) ? { state: 'hidden' } : { state: 'unavailable' };
  }
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
    ? {
        type,
        ...resolveEmbedView(
          id,
          ctx.models,
          ctx.matureModels,
          ctx.canEnableMature,
          ctx.hiddenModels
        ),
      }
    : {
        type,
        ...resolveEmbedView(
          id,
          ctx.images,
          ctx.matureImages,
          ctx.canEnableMature,
          ctx.hiddenImages
        ),
      };
}
