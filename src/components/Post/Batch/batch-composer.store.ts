import { createContext, useContext } from 'react';
import { createStore, useStore } from 'zustand';
import { shallow } from 'zustand/shallow';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type { MediaUploadOnCompleteProps } from '~/hooks/useMediaUpload';
import type { GenerationResource } from '~/shared/types/generation.types';
import { POST_IMAGE_LIMIT } from '~/server/common/constants';
import type {
  BatchMedia,
  BatchScanStatus,
  ComposerDraft,
  PlannedPost,
  PromotedVersion,
  ScheduleSettings,
} from './batch-composer.utils';
import { defaultScheduleSettings, defaultTitleTemplate, shuffle } from './batch-composer.utils';

export type NamedOption = { id: number; name: string };

/** Section 2 of the composer. Serialisable on its own so it can become a saved preset later. */
export type SharedSettings = {
  promotedVersionId: number | null;
  resources: GenerationResource[];
  tools: NamedOption[];
  techniques: NamedOption[];
  tags: string[];
  titleTemplate: string;
};

export type ReviewPost = PlannedPost & { removed?: boolean };

export type BatchComposerState = {
  media: BatchMedia[];
  imagesPerPost: number;
  shared: SharedSettings;
  /** Names behind `shared.promotedVersionId`, from the version query or the picked resource. */
  promotedNames: { model: string; version: string } | null;
  /** The saved preset section 2 currently matches; cleared by any edit to it. */
  presetId: number | null;
  schedule: ScheduleSettings;
  seed: number;
  /** Dates produced by "Fix spacing automatically"; dropped by any edit that changes the plan. */
  fixedDates: Date[] | null;
  screen: 'edit' | 'review';
  reviewPlan: ReviewPost[] | null;
  /** False until the saved draft has been read, so nothing is saved over it in the meantime. */
  hydrated: boolean;
  /** Set once every post was created; the state still holds the media but is no longer a draft. */
  submitted: boolean;
  addMedia: (media: MediaUploadOnCompleteProps) => void;
  /** No-op for a url that is no longer in the grid. */
  patchMedia: (url: string, patch: Partial<Omit<BatchMedia, 'url'>>) => void;
  /** Applies one `getBatchMediaStatus` answer; an id that was asked for and not answered is no
   *  longer the creator's draft, so its entry goes. */
  applyScanStatus: (requestedIds: number[], statuses: Record<number, BatchScanStatus>) => void;
  removeMedia: (url: string) => void;
  shuffleMedia: () => void;
  setImagesPerPost: (count: number) => void;
  updateShared: (patch: Partial<SharedSettings>) => void;
  /** Names may lag the id while the version query is in flight. */
  setPromoted: (version: ({ id: number } & Partial<PromotedVersion>) | null) => void;
  hydrate: (draft: ComposerDraft | null) => void;
  markSubmitted: () => void;
  applyPreset: (presetId: number | null, settings: Partial<SharedSettings>) => void;
  updateSchedule: (patch: Partial<ScheduleSettings>) => void;
  setFixedDates: (dates: Date[] | null) => void;
  openReview: (plan: PlannedPost[]) => void;
  closeReview: () => void;
  updateReviewPost: (
    key: string,
    patch: Partial<Pick<ReviewPost, 'title' | 'publishedAt'>>
  ) => void;
  removeReviewPost: (key: string) => void;
  reset: () => void;
};

export type BatchComposerStore = ReturnType<typeof createBatchComposerStore>;

export function createBatchComposerStore(input: {
  promotedVersionId: number | null;
  titleTemplate: string;
  startAt?: Date | null;
  now?: Date;
}) {
  const initial = () => ({
    media: [] as BatchMedia[],
    imagesPerPost: 1,
    shared: {
      promotedVersionId: input.promotedVersionId,
      resources: [],
      tools: [],
      techniques: [],
      tags: [],
      titleTemplate: input.titleTemplate,
    },
    promotedNames: null,
    presetId: null,
    schedule: defaultScheduleSettings(input.now ?? new Date(), input.startAt),
    seed: Math.floor(Math.random() * 2 ** 31),
    fixedDates: null,
    screen: 'edit' as const,
    reviewPlan: null,
    hydrated: false,
    submitted: false,
  });

  return createStore<BatchComposerState>()(
    devtools(
      immer((set) => ({
        ...initial(),
        addMedia: (media) =>
          set((state) => {
            const index = state.media.findIndex((x) => x.url === media.url);
            if (index > -1) state.media[index] = media;
            else state.media.push(media);
            state.fixedDates = null;
          }),
        patchMedia: (url, patch) =>
          set((state) => {
            const entry = state.media.find((x) => x.url === url);
            if (entry) Object.assign(entry, patch);
          }),
        applyScanStatus: (requestedIds, statuses) =>
          set((state) => {
            const gone = new Set(requestedIds.filter((id) => !(id in statuses)));
            for (const entry of state.media) {
              if (entry.imageId === undefined) continue;
              const status = statuses[entry.imageId];
              if (status) Object.assign(entry, status);
            }
            if (gone.size) {
              state.media = state.media.filter(
                (entry) => entry.imageId === undefined || !gone.has(entry.imageId)
              );
              state.fixedDates = null;
            }
          }),
        removeMedia: (url) =>
          set((state) => {
            state.media = state.media.filter((x) => x.url !== url);
            state.fixedDates = null;
          }),
        shuffleMedia: () =>
          set((state) => {
            state.media = shuffle(state.media);
          }),
        setImagesPerPost: (count) =>
          set((state) => {
            state.imagesPerPost = Math.min(POST_IMAGE_LIMIT, Math.max(1, Math.floor(count)));
            state.fixedDates = null;
          }),
        updateShared: (patch) =>
          set((state) => {
            Object.assign(state.shared, patch);
            state.presetId = null;
          }),
        setPromoted: (version) =>
          set((state) => {
            if (
              version &&
              version.id !== state.shared.promotedVersionId &&
              !state.shared.titleTemplate
            )
              state.shared.titleTemplate = defaultTitleTemplate(true);
            state.shared.promotedVersionId = version?.id ?? null;
            state.promotedNames =
              version?.model && version.version
                ? { model: version.model, version: version.version }
                : null;
          }),
        hydrate: (draft) =>
          set((state) => {
            state.hydrated = true;
            if (!draft) return;
            const uploadedMeanwhile = state.media.filter(
              (item) => !draft.media.some((saved) => saved.url === item.url)
            );
            state.media = [...draft.media, ...uploadedMeanwhile];
            state.imagesPerPost = draft.imagesPerPost;
            state.shared = draft.shared;
            state.promotedNames = draft.promotedNames;
            state.presetId = draft.presetId;
            state.schedule = draft.schedule;
            state.seed = draft.seed;
            state.fixedDates = draft.fixedDates;
          }),
        markSubmitted: () =>
          set((state) => {
            state.submitted = true;
          }),
        applyPreset: (presetId, settings) =>
          set((state) => {
            Object.assign(state.shared, settings);
            state.presetId = presetId;
          }),
        updateSchedule: (patch) =>
          set((state) => {
            Object.assign(state.schedule, patch);
            state.fixedDates = null;
          }),
        setFixedDates: (dates) =>
          set((state) => {
            state.fixedDates = dates;
          }),
        openReview: (plan) =>
          set((state) => {
            state.reviewPlan = plan;
            state.screen = 'review';
          }),
        closeReview: () =>
          set((state) => {
            state.reviewPlan = null;
            state.screen = 'edit';
          }),
        updateReviewPost: (key, patch) =>
          set((state) => {
            const post = state.reviewPlan?.find((x) => x.key === key);
            if (post) Object.assign(post, patch);
          }),
        removeReviewPost: (key) =>
          set((state) => {
            if (state.reviewPlan) state.reviewPlan = state.reviewPlan.filter((x) => x.key !== key);
          }),
        reset: () => set({ ...initial(), hydrated: true }),
      })),
      { name: 'batch-composer' }
    )
  );
}

export const BatchComposerStoreContext = createContext<BatchComposerStore | null>(null);

export function useBatchComposerStore<T>(selector: (state: BatchComposerState) => T): T {
  const store = useContext(BatchComposerStoreContext);
  if (!store) throw new Error('missing BatchComposerProvider');
  return useStore(store, selector, shallow);
}

export function useBatchComposerStoreApi() {
  const store = useContext(BatchComposerStoreContext);
  if (!store) throw new Error('missing BatchComposerProvider');
  return store;
}
