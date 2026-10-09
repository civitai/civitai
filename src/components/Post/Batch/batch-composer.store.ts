import { createContext, useContext } from 'react';
import { createStore, useStore } from 'zustand';
import { shallow } from 'zustand/shallow';
import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import type { MediaUploadOnCompleteProps } from '~/hooks/useMediaUpload';
import type { GenerationResource } from '~/shared/types/generation.types';
import { POST_IMAGE_LIMIT } from '~/server/common/constants';
import type { PlannedPost, ScheduleSettings } from './batch-composer.utils';
import { defaultScheduleSettings, shuffle } from './batch-composer.utils';

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
  media: MediaUploadOnCompleteProps[];
  imagesPerPost: number;
  shared: SharedSettings;
  schedule: ScheduleSettings;
  seed: number;
  /** Dates produced by "Fix spacing automatically"; dropped by any edit that changes the plan. */
  fixedDates: Date[] | null;
  screen: 'edit' | 'review';
  reviewPlan: ReviewPost[] | null;
  addMedia: (media: MediaUploadOnCompleteProps) => void;
  removeMedia: (url: string) => void;
  shuffleMedia: () => void;
  setImagesPerPost: (count: number) => void;
  updateShared: (patch: Partial<SharedSettings>) => void;
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
    media: [] as MediaUploadOnCompleteProps[],
    imagesPerPost: 1,
    shared: {
      promotedVersionId: input.promotedVersionId,
      resources: [],
      tools: [],
      techniques: [],
      tags: [],
      titleTemplate: input.titleTemplate,
    },
    schedule: defaultScheduleSettings(input.now ?? new Date(), input.startAt),
    seed: Math.floor(Math.random() * 2 ** 31),
    fixedDates: null,
    screen: 'edit' as const,
    reviewPlan: null,
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
        reset: () => set(initial()),
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
