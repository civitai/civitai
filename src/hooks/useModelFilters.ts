import { ModelType, MetricTimeframe } from '~/shared/utils/prisma/enums';
import { useRouter } from 'next/router';
import * as z from 'zod/v4';
import { ModelSort } from '~/server/common/enums';
import { QS } from '~/utils/qs';
import type { SetStateAction } from 'react';
import { useCallback, useMemo } from 'react';
import { isDefined } from '~/utils/type-guards';
import { constants } from '~/server/common/constants';

const filterSchema = z.object({
  types: z
    .union([z.enum(ModelType), z.enum(ModelType).array()])
    .transform((rel) => {
      if (!rel) return undefined;
      return Array.isArray(rel) ? rel : [rel];
    })
    .optional(),
  baseModels: z
    .union([z.enum(constants.baseModels), z.enum(constants.baseModels).array()])
    .transform((rel) => {
      if (!rel) return undefined;
      return Array.isArray(rel) ? rel : [rel];
    })
    .optional(),
  sort: z.enum(ModelSort).optional(),
  period: z.enum(MetricTimeframe).optional(),
  query: z.string().optional(),
  username: z.string().optional(),
  tag: z.string().optional(),
});

type FilterState = z.infer<typeof filterSchema>;

// DEPRECATED
export function useModelFilters() {
  const router = useRouter();

  const filters = useMemo(() => {
    const queryProps = Object.entries(router.query) as [string, any][]; //eslint-disable-line
    return queryProps
      .map(([key, value]) => {
        const result = filterSchema.safeParse({ [key]: value });
        if (!result.success) console.error('error parsing filters');
        return result.success ? result.data : undefined;
      })
      .filter(isDefined)
      .reduce<FilterState>((acc, value) => ({ ...acc, ...value }), {
        ...constants.modelFilterDefaults,
      });
  }, [router.query]);

  const setFilters = useCallback(
    (value: SetStateAction<FilterState>) => {
      const newParams = typeof value === 'function' ? value(router.query) : value;
      const result = filterSchema.safeParse(newParams);
      if (!result.success) throw new Error('Invalid filter value');
      const stringified = QS.stringify(result.data);
      if (!!stringified.length) {
        localStorage.setItem('defaultModelFilter', stringified);
        router.push(`/models?${stringified}`);
      } else {
        localStorage.removeItem('defaultModelFilter');
        router.replace('/models', undefined, { shallow: true });
      }
    },
    [router]
  );

  return { filters, setFilters };
}
