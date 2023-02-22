import { useSetState } from '@mantine/hooks';
import {
  CheckpointType,
  ImageGenerationProcess,
  MetricTimeframe,
  ModelStatus,
  ModelType,
} from '@prisma/client';
import React, { createContext, useContext } from 'react';
import { z } from 'zod';

import { constants } from '~/server/common/constants';
import {
  BrowsingMode,
  ImageResource,
  ImageSort,
  ModelSort,
  QuestionSort,
  QuestionStatus,
} from '~/server/common/enums';

export const modelFilterSchema = z.object({
  sort: z.nativeEnum(ModelSort).optional(),
  period: z.nativeEnum(MetricTimeframe).optional(),
  types: z.nativeEnum(ModelType).array().optional(),
  checkpointType: z.nativeEnum(CheckpointType).optional(),
  baseModels: z.enum(constants.baseModels).array().optional(),
  browsingMode: z.nativeEnum(BrowsingMode).optional(),
  status: z.nativeEnum(ModelStatus).array().optional(),
});

export const questionsFilterSchema = z.object({
  sort: z.nativeEnum(QuestionSort).optional(),
  period: z.nativeEnum(MetricTimeframe).optional(),
  status: z.nativeEnum(QuestionStatus).optional(),
});

export const galleryFilterSchema = z.object({
  sort: z.nativeEnum(ImageSort).optional(),
  period: z.nativeEnum(MetricTimeframe).optional(),
  browsingMode: z.nativeEnum(BrowsingMode).optional(),
  singleImageModel: z.boolean().optional(),
  singleImageAlbum: z.boolean().optional(),
  types: z.nativeEnum(ImageGenerationProcess).array().optional(),
  resources: z.nativeEnum(ImageResource).array().optional(),
  tags: z.number().array().optional(),
  excludedTags: z.number().array().optional(),
});

const CookiesCtx = createContext<CookiesContext>({} as CookiesContext);
export const useCookies = () => useContext(CookiesCtx);
export const CookiesProvider = ({
  children,
  value: initialValue,
}: {
  children: React.ReactNode;
  value: CookiesContext;
}) => {
  const [value] = useSetState(initialValue);
  return <CookiesCtx.Provider value={value}>{children}</CookiesCtx.Provider>;
};

const cookiesSchema = z.object({
  models: modelFilterSchema,
  questions: questionsFilterSchema,
  gallery: galleryFilterSchema,
});
export type CookiesContext = z.input<typeof cookiesSchema>;

export function parseCookies(
  cookies: Partial<{
    [key: string]: string;
  }>
) {
  return zodParse({
    models: {
      sort: cookies?.['f_sort'],
      period: cookies?.['f_period'],
      types: cookies?.['f_types'],
      baseModels: cookies?.['f_baseModels'],
      browsingMode: cookies?.['f_browsingMode'],
      status: cookies?.['f_status'],
      checkpointType: cookies?.['f_ckptType'],
    },
    questions: {
      sort: cookies?.['q_sort'],
      period: cookies?.['q_period'],
      status: cookies?.['q_status'],
    },
    gallery: {
      sort: cookies?.['g_sort'],
      period: cookies?.['g_period'],
      browsingMode: cookies?.['g_browsingMode'],
      singleImageModel: cookies?.['g_singleImageModel'],
      singleImageAlbum: cookies?.['g_singleImageAlbum'],
      types: cookies?.['g_types'],
      resources: cookies?.['g_resources'],
      tags: cookies?.['g_tags'],
      excludedTags: cookies?.['g_excludedTags'],
    },
  });
}

const zodParse = z
  .function()
  .args(
    z.object({
      models: z
        .object({
          sort: z.string(),
          period: z.string(),
          types: z.string(),
          baseModels: z.string(),
          browsingMode: z.string(),
          status: z.string(),
          checkpointType: z.string(),
        })
        .partial(),
      questions: z
        .object({
          sort: z.string(),
          period: z.string(),
          status: z.string(),
        })
        .partial(),
      gallery: z
        .object({
          sort: z.string(),
          period: z.string(),
          browsingMode: z.string(),
          singleImageModel: z.string(),
          singleImageAlbum: z.string(),
          types: z.string(),
          resources: z.string(),
          tags: z.string(),
          excludedTags: z.string(),
        })
        .partial(),
    })
  )
  .implement(
    ({ models, questions, gallery }) =>
      ({
        models: {
          ...models,
          types: !!models.types ? JSON.parse(decodeURIComponent(models.types)) : [],
          baseModels: !!models.baseModels ? JSON.parse(decodeURIComponent(models.baseModels)) : [],
          status: !!models.status ? JSON.parse(decodeURIComponent(models.status)) : [],
        },
        questions,
        gallery: {
          ...gallery,
          singleImageModel: gallery.singleImageModel === 'true',
          singleImageAlbum: gallery.singleImageAlbum === 'true',
          types: !!gallery.types ? JSON.parse(decodeURIComponent(gallery.types)) : [],
          resources: !!gallery.resources ? JSON.parse(decodeURIComponent(gallery.resources)) : [],
          tags: !!gallery.tags ? JSON.parse(decodeURIComponent(gallery.tags)) : [],
          excludedTags: !!gallery.excludedTags
            ? JSON.parse(decodeURIComponent(gallery.excludedTags))
            : [],
        },
      } as CookiesContext)
  );

// function createCookiesAccessor<TDictionary extends Record<string, string>>(
//   dictionary: TDictionary
// ) {
//   return dictionary;
// }

// const test = createCookiesAccessor({ sort: 'f_sort' });
