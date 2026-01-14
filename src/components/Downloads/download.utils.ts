import { useRouter } from 'next/router';
import { useCallback, useMemo } from 'react';
import * as z from 'zod';
import dayjs from '~/shared/utils/dayjs';
import type { DownloadHistoryItem } from '~/server/services/download.service';
import type { ModelType } from '~/shared/utils/prisma/enums';
import type { BaseModel } from '~/shared/constants/base-model.constants';

// Period options for time-based filtering
export const downloadPeriods = ['all', 'day', 'week', 'month', 'year'] as const;
export type DownloadPeriod = (typeof downloadPeriods)[number];

export const downloadFilterSchema = z.object({
  query: z.string().optional(),
  modelTypes: z.string().array().optional(),
  fileTypes: z.string().array().optional(),
  formats: z.string().array().optional(),
  baseModels: z.string().array().optional(),
  period: z.enum(downloadPeriods).optional(),
});

export type DownloadFilters = z.infer<typeof downloadFilterSchema>;

// Get cutoff date for time period filtering
export function getCutoffDate(period: DownloadPeriod): Date | null {
  const now = dayjs();
  switch (period) {
    case 'day':
      return now.subtract(1, 'day').toDate();
    case 'week':
      return now.subtract(1, 'week').toDate();
    case 'month':
      return now.subtract(1, 'month').toDate();
    case 'year':
      return now.subtract(1, 'year').toDate();
    case 'all':
    default:
      return null;
  }
}

// Custom hook to manage download filters with URL params
export function useDownloadFilters() {
  const router = useRouter();

  const filters = useMemo<DownloadFilters>(() => {
    const { query, modelTypes, fileTypes, formats, baseModels, period } = router.query;
    return {
      query: typeof query === 'string' ? query : undefined,
      modelTypes: typeof modelTypes === 'string' ? modelTypes.split(',') : undefined,
      fileTypes: typeof fileTypes === 'string' ? fileTypes.split(',') : undefined,
      formats: typeof formats === 'string' ? formats.split(',') : undefined,
      baseModels: typeof baseModels === 'string' ? baseModels.split(',') : undefined,
      period:
        typeof period === 'string' && downloadPeriods.includes(period as DownloadPeriod)
          ? (period as DownloadPeriod)
          : undefined,
    };
  }, [router.query]);

  const setFilters = useCallback(
    (newFilters: Partial<DownloadFilters>) => {
      const updatedFilters = { ...filters, ...newFilters };

      const query: Record<string, string | undefined> = {};
      if (updatedFilters.query) query.query = updatedFilters.query;
      if (updatedFilters.modelTypes?.length) query.modelTypes = updatedFilters.modelTypes.join(',');
      if (updatedFilters.fileTypes?.length) query.fileTypes = updatedFilters.fileTypes.join(',');
      if (updatedFilters.formats?.length) query.formats = updatedFilters.formats.join(',');
      if (updatedFilters.baseModels?.length) query.baseModels = updatedFilters.baseModels.join(',');
      if (updatedFilters.period && updatedFilters.period !== 'all')
        query.period = updatedFilters.period;

      router.replace({ pathname: router.pathname, query }, undefined, { shallow: true });
    },
    [filters, router]
  );

  const clearFilters = useCallback(() => {
    router.replace({ pathname: router.pathname }, undefined, { shallow: true });
  }, [router]);

  const hasActiveFilters = useMemo(() => {
    return Boolean(
      filters.query ||
        filters.modelTypes?.length ||
        filters.fileTypes?.length ||
        filters.formats?.length ||
        filters.baseModels?.length ||
        (filters.period && filters.period !== 'all')
    );
  }, [filters]);

  return { filters, setFilters, clearFilters, hasActiveFilters };
}

// Filter downloads based on filters
export function filterDownloads(
  downloads: DownloadHistoryItem[],
  filters: DownloadFilters
): DownloadHistoryItem[] {
  let result = downloads;

  // Filter by model types
  if (filters.modelTypes?.length) {
    result = result.filter((d) => filters.modelTypes!.includes(d.modelVersion.model.type));
  }

  // Filter by file types
  if (filters.fileTypes?.length) {
    result = result.filter((d) => d.file && filters.fileTypes!.includes(d.file.type));
  }

  // Filter by formats
  if (filters.formats?.length) {
    result = result.filter((d) => d.file?.format && filters.formats!.includes(d.file.format));
  }

  // Filter by base models
  if (filters.baseModels?.length) {
    result = result.filter((d) => filters.baseModels!.includes(d.modelVersion.baseModel));
  }

  // Filter by time period
  if (filters.period && filters.period !== 'all') {
    const cutoff = getCutoffDate(filters.period);
    if (cutoff) {
      result = result.filter((d) => new Date(d.downloadAt) >= cutoff);
    }
  }

  // Filter by search query
  if (filters.query) {
    const q = filters.query.toLowerCase();
    result = result.filter(
      (d) =>
        d.modelVersion.model.name.toLowerCase().includes(q) ||
        d.modelVersion.name.toLowerCase().includes(q)
    );
  }

  return result;
}

// Extract available filter options from downloads
export function getAvailableFilterOptions(downloads: DownloadHistoryItem[]) {
  const modelTypes = new Set<ModelType>();
  const fileTypes = new Set<string>();
  const formats = new Set<string>();
  const baseModels = new Set<BaseModel>();

  for (const download of downloads) {
    modelTypes.add(download.modelVersion.model.type);
    if (download.file) {
      fileTypes.add(download.file.type);
      if (download.file.format) {
        formats.add(download.file.format);
      }
    }
    baseModels.add(download.modelVersion.baseModel);
  }

  return {
    modelTypes: Array.from(modelTypes).sort(),
    fileTypes: Array.from(fileTypes).sort(),
    formats: Array.from(formats).sort(),
    baseModels: Array.from(baseModels).sort(),
  };
}

// Period label mapping
export const periodLabels: Record<DownloadPeriod, string> = {
  all: 'All Time',
  day: 'Last 24 Hours',
  week: 'Last Week',
  month: 'Last Month',
  year: 'Last Year',
};
