import { MetricTimeframe, ModelType } from '@prisma/client';
import React, { createContext, useContext } from 'react';
import { z } from 'zod';
import { constants } from '~/server/common/constants';
import { ModelSort } from '~/server/common/enums';

export const modelFilterSchema = z.object({
  sort: z.nativeEnum(ModelSort).optional(),
  period: z.nativeEnum(MetricTimeframe).optional(),
  types: z.nativeEnum(ModelType).array().optional(),
  baseModels: z.enum(constants.baseModels).array().optional(),
});

// extend cookies context with additional types as needed
const cookiesSchema = z.object({}).merge(modelFilterSchema);

export type CookiesContext = z.input<typeof cookiesSchema>;

export const parseCookies = z
  .function()
  .args(
    z
      .object({
        sort: z.string(),
        period: z.string(),
        types: z.string(),
        baseModels: z.string(),
      })
      .partial()
  )
  .implement(({ types, baseModels, ...args }) => ({
    ...args,
    types: !!types ? JSON.parse(decodeURIComponent(types)) : [],
    baseModels: !!baseModels ? JSON.parse(decodeURIComponent(baseModels)) : [],
  }));

const CookiesCtx = createContext<CookiesContext>({});
export const useCookies = () => useContext(CookiesCtx);
export const CookiesProvider = ({
  children,
  value,
}: {
  children: React.ReactNode;
  value: CookiesContext;
}) => <CookiesCtx.Provider value={value}>{children}</CookiesCtx.Provider>;
