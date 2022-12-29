import { MetricTimeframe, ModelType } from '@prisma/client';
import React, { createContext, useContext } from 'react';
import { z } from 'zod';
import { constants } from '~/server/common/constants';
import { BountySort, ModelSort, QuestionSort, QuestionStatus } from '~/server/common/enums';

export const modelFilterSchema = z.object({
  sort: z.nativeEnum(ModelSort).optional(),
  period: z.nativeEnum(MetricTimeframe).optional(),
  types: z.nativeEnum(ModelType).array().optional(),
  baseModels: z.enum(constants.baseModels).array().optional(),
});

export const questionsFilterSchema = z.object({
  sort: z.nativeEnum(QuestionSort).optional(),
  period: z.nativeEnum(MetricTimeframe).optional(),
  status: z.nativeEnum(QuestionStatus).optional(),
});

export const bountiesFilterSchema = z.object({
  sort: z.nativeEnum(BountySort).optional(),
  period: z.nativeEnum(MetricTimeframe).optional(),
  types: z.nativeEnum(ModelType).array().optional(),
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
  bounties: bountiesFilterSchema,
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
    },
    questions: {
      sort: cookies?.['q_sort'],
      period: cookies?.['q_period'],
      status: cookies?.['q_status'],
    },
    bounties: {
      sort: cookies?.['b_sort'],
      period: cookies?.['b_period'],
      types: cookies?.['b_types'],
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
        })
        .partial(),
      questions: z
        .object({
          sort: z.string(),
          period: z.string(),
          status: z.string(),
        })
        .partial(),
      bounties: z
        .object({
          sort: z.string(),
          period: z.string(),
          types: z.string(),
        })
        .partial(),
    })
  )
  .implement(
    ({ models, questions, bounties }) =>
      ({
        models: {
          ...models,
          types: !!models.types ? JSON.parse(decodeURIComponent(models.types)) : [],
          baseModels: !!models.baseModels ? JSON.parse(decodeURIComponent(models.baseModels)) : [],
        },
        bounties: {
          ...bounties,
          types: !!bounties.types ? JSON.parse(decodeURIComponent(bounties.types)) : [],
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
