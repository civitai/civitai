import { CheckpointType, MetricTimeframe, ModelType } from '@prisma/client';
import React, { createContext, useContext } from 'react';
import { z } from 'zod';
import { constants } from '~/server/common/constants';
import { ModelSort, QuestionSort, QuestionStatus } from '~/server/common/enums';

export const modelFilterSchema = z.object({
  sort: z.nativeEnum(ModelSort).optional(),
  period: z.nativeEnum(MetricTimeframe).optional(),
  types: z.nativeEnum(ModelType).array().optional(),
  checkpointType: z.nativeEnum(CheckpointType).optional(),
  baseModels: z.enum(constants.baseModels).array().optional(),
  hideNSFW: z.boolean().optional(),
});

export const questionsFilterSchema = z.object({
  sort: z.nativeEnum(QuestionSort).optional(),
  period: z.nativeEnum(MetricTimeframe).optional(),
  status: z.nativeEnum(QuestionStatus).optional(),
});

const CookiesCtx = createContext<CookiesContext>({} as CookiesContext);
export const useCookies = () => useContext(CookiesCtx);
export const CookiesProvider = ({
  children,
  value,
}: {
  children: React.ReactNode;
  value: CookiesContext;
}) => <CookiesCtx.Provider value={value}>{children}</CookiesCtx.Provider>;

const cookiesSchema = z.object({
  models: modelFilterSchema,
  questions: questionsFilterSchema,
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
    },
    questions: {
      sort: cookies?.['q_sort'],
      period: cookies?.['q_period'],
      status: cookies?.['q_status'],
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
        })
        .partial(),
      questions: z
        .object({
          sort: z.string(),
          period: z.string(),
          status: z.string(),
        })
        .partial(),
    })
  )
  .implement(
    ({ models, questions }) =>
      ({
        models: {
          ...models,
          types: !!models.types ? JSON.parse(decodeURIComponent(models.types)) : [],
          baseModels: !!models.baseModels ? JSON.parse(decodeURIComponent(models.baseModels)) : [],
          hideNSFW: models?.hideNSFW === 'true',
        },
        questions,
      } as CookiesContext)
  );

// function createCookiesAccessor<TDictionary extends Record<string, string>>(
//   dictionary: TDictionary
// ) {
//   return dictionary;
// }

// const test = createCookiesAccessor({ sort: 'f_sort' });
