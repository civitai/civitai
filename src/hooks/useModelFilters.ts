import { ModelType, MetricTimeframe } from '@prisma/client';
import { useRouter } from 'next/router';
import { z } from 'zod';
import { ModelSort } from '~/server/common/enums';
import { QS } from '~/utils/qs';
import { SetStateAction, useCallback, useMemo } from 'react';
import { isDefined } from '~/utils/type-guards';

const filterSchema = z.object({
  types: z
    .union([z.nativeEnum(ModelType), z.nativeEnum(ModelType).array()])
    .optional()
    .transform((rel) => {
      if (!rel) return undefined;
      return Array.isArray(rel) ? rel : [rel];
    }),
  sort: z.nativeEnum(ModelSort).optional(),
  period: z.nativeEnum(MetricTimeframe).optional(),
  query: z.string().optional(),
  user: z.string().optional(),
  tag: z.string().optional(),
});

type FilterState = z.infer<typeof filterSchema>;

export function useModelFilters() {
  const router = useRouter();

  const queryParams = useMemo(
    () => QS.parse(router.asPath.substring(router.asPath.indexOf('?') + 1)),
    [router.asPath]
  );

  const filters = useMemo(() => {
    return Object.keys(queryParams)
      .map((key) => {
        const result = filterSchema.safeParse({ [key]: queryParams[key] });
        if (!result.success) console.error('error parsing filters');
        return result.success ? result.data : undefined;
      })
      .filter(isDefined)
      .reduce<FilterState>((acc, value) => ({ ...acc, ...value }), {
        period: MetricTimeframe.AllTime,
        sort: ModelSort.HighestRated,
      });
  }, [queryParams]);

  const setFilters = useCallback(
    (value: SetStateAction<FilterState>) => {
      const newParams = typeof value === 'function' ? value(queryParams) : value;
      const result = filterSchema.safeParse(newParams);
      if (!result.success) throw new Error('Invalid filter value');
      const stringified = QS.stringify(result.data);
      const url = !!stringified.length ? `/?${stringified}` : '/';
      if (router.route !== '/') router.push(url);
      else router.replace(url, undefined, { shallow: true });
    },
    [queryParams, router]
  );

  return { filters, setFilters };
}
