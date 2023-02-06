import { useSetState } from '@mantine/hooks';
import { CheckpointType, MetricTimeframe, ModelStatus, ModelType } from '@prisma/client';
import React, { createContext, useContext } from 'react';
import { z } from 'zod';
import { constants } from '~/server/common/constants';
import { ImageSort, ModelSort, QuestionSort, QuestionStatus } from '~/server/common/enums';

export const modelFilterSchema = z.object({
  sort: z.nativeEnum(ModelSort).optional(),
  period: z.nativeEnum(MetricTimeframe).optional(),
  types: z.nativeEnum(ModelType).array().optional(),
  checkpointType: z.nativeEnum(CheckpointType).optional(),
  baseModels: z.enum(constants.baseModels).array().optional(),
  hideNSFW: z.boolean().optional(),
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
  hideNSFW: z.boolean().optional(),
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
      hideNSFW: cookies?.['f_hideNSFW'],
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
      hideNSFW: cookies?.['g_hideNSFW'],
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
          hideNSFW: z.string(),
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
          hideNSFW: z.string(),
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
          hideNSFW: models?.hideNSFW === 'true',
          status: !!models.status ? JSON.parse(decodeURIComponent(models.status)) : [],
        },
        questions,
        gallery: { ...gallery, hideNSFW: gallery.hideNSFW === 'true' },
      } as CookiesContext)
  );

// function createCookiesAccessor<TDictionary extends Record<string, string>>(
//   dictionary: TDictionary
// ) {
//   return dictionary;
// }

// const test = createCookiesAccessor({ sort: 'f_sort' });
