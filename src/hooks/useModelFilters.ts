import { ModelType, MetricTimeframe } from '@prisma/client';
import { useRouter } from 'next/router';
import { z } from 'zod';
import { ModelSort } from '~/server/common/enums';
import { QS } from '~/utils/qs';
import { SetStateAction, useCallback, useMemo } from 'react';
import { isDefined } from '~/utils/type-guards';
import { constants } from '~/server/common/constants';

const filterSchema = z.object({
  types: z
    .union([z.nativeEnum(ModelType), z.nativeEnum(ModelType).array()])
    .optional()
    .transform((rel) => {
      if (!rel) return undefined;
      return Array.isArray(rel) ? rel : [rel];
    }),
  baseModels: z
    .union([z.enum(constants.baseModels), z.enum(constants.baseModels).array()])
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
