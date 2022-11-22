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
  username: z.string().optional(),
  tag: z.string().optional(),
});

type FilterState = z.infer<typeof filterSchema>;

export function useModelFilters() {
  const router = useRouter();

  const filters = useMemo(() => {
    return Object.keys(router.query)
      .map((key) => {
        const result = filterSchema.safeParse({ [key]: router.query[key] });
        if (!result.success) console.error('error parsing filters');
        return result.success ? result.data : undefined;
      })
      .filter(isDefined)
      .reduce<FilterState>((acc, value) => ({ ...acc, ...value }), {
        period: MetricTimeframe.AllTime,
        sort: ModelSort.HighestRated,
      });
  }, [router.query]);

  const setFilters = useCallback(
    (value: SetStateAction<FilterState>) => {
      const newParams = typeof value === 'function' ? value(router.query) : value;
      const result = filterSchema.safeParse(newParams);
      if (!result.success) throw new Error('Invalid filter value');
      const stringified = QS.stringify(result.data);
      const url = !!stringified.length ? `/?${stringified}` : '/';
      if (router.route !== '/') router.push(url);
      else router.replace(url, undefined, { shallow: true });
    },
    [router]
  );

  return { filters, setFilters };
}
