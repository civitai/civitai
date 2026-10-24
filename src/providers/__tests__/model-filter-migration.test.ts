import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { ModelSort } from '~/server/common/enums';
import {
  MODEL_FILTER_MIGRATION_KEY,
  MODEL_FILTER_MIGRATION_VERSION,
  migrateModelFilters,
} from '~/providers/FiltersProvider';

/**
 * The store persists defaults as though they were chosen, so the rewrite is scoped to the
 * exact old pair; any other value is a real preference and must survive.
 */
const MODELS_KEY = 'model-filters';
const oldDefaults = { sort: ModelSort.HighestRated, period: MetricTimeframe.Month };

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
});

describe('model filter migration', () => {
  beforeEach(() => store.clear());

  it('replaces the exact old default pair with Hot + AllTime', () => {
    const result = migrateModelFilters(MODELS_KEY, { ...oldDefaults });

    expect(result).toMatchObject({
      sort: ModelSort.Hot,
      period: MetricTimeframe.AllTime,
    });
    expect(JSON.parse(store.get(MODELS_KEY) as string)).toMatchObject({
      sort: ModelSort.Hot,
      period: MetricTimeframe.AllTime,
    });
  });

  it('keeps every other field while rewriting the pair', () => {
    const result = migrateModelFilters(MODELS_KEY, {
      ...oldDefaults,
      types: ['LORA'],
      baseModels: ['Illustrious'],
    });

    expect(result).toMatchObject({ types: ['LORA'], baseModels: ['Illustrious'] });
  });

  it.each([
    ['a chosen sort', { sort: ModelSort.MostDownloaded, period: MetricTimeframe.Month }],
    ['a chosen period', { sort: ModelSort.HighestRated, period: MetricTimeframe.Week }],
    ['both chosen', { sort: ModelSort.Newest, period: MetricTimeframe.AllTime }],
  ])('leaves %s untouched', (_label, saved) => {
    expect(migrateModelFilters(MODELS_KEY, { ...saved })).toEqual(saved);
  });

  it('runs once per browser', () => {
    migrateModelFilters(MODELS_KEY, { ...oldDefaults });
    expect(store.get(MODEL_FILTER_MIGRATION_KEY)).toBe(MODEL_FILTER_MIGRATION_VERSION);

    // Someone who deliberately picks the old pair AFTER the migration ran keeps it.
    const second = migrateModelFilters(MODELS_KEY, { ...oldDefaults });
    expect(second).toEqual(oldDefaults);
  });

  it('marks itself done even when there was nothing to rewrite', () => {
    migrateModelFilters(MODELS_KEY, { sort: ModelSort.Newest, period: MetricTimeframe.Week });
    expect(store.get(MODEL_FILTER_MIGRATION_KEY)).toBe(MODEL_FILTER_MIGRATION_VERSION);
  });

  it('ignores every other filter store', () => {
    // The guard is the storage key, not the shape: image/post/article filters have a
    // `sort` and `period` too, and `Highest Rated` is not even in their enums.
    const imageFilters = { ...oldDefaults };
    expect(migrateModelFilters('image-filters', imageFilters)).toEqual(oldDefaults);
    expect(store.get(MODEL_FILTER_MIGRATION_KEY)).toBeUndefined();
  });

  it('survives an empty store without inventing filters', () => {
    expect(migrateModelFilters(MODELS_KEY, {})).toEqual({});
    expect(store.get(MODELS_KEY)).toBeUndefined();
  });
});
