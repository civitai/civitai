import { useRouter } from 'next/router';
import type { ParsedUrlQueryInput } from 'querystring';
import { useMemo } from 'react';
import type * as z from 'zod';
import { removeEmpty } from '~/utils/object-helpers';

export function useZodRouteParams<TSchema extends z.ZodObject>(schema: TSchema) {
  const { query, pathname, replace } = useRouter();

  return useMemo(() => {
    const result = schema.safeParse(query);
    const data = result.success ? result.data : {};

    const replaceParams = (params: Partial<z.input<TSchema>>, as?: string) => {
      const data = removeEmpty(schema.parse({ ...query, ...params }));
      replace({ pathname, query: data as ParsedUrlQueryInput }, as, {
        shallow: true,
        scroll: false,
      });
    };

    // const clearParams = () => {
    //   const clearable = Object.keys(data).reduce<Record<string, undefined>>(
    //     (acc, key) => ({ ...acc, [key]: undefined }),
    //     {}
    //   );
    //   replaceParams(clearable);
    // };

    return {
      query: data as z.infer<TSchema>,
      replace: replaceParams,
    };
  }, [query, pathname, replace]); // eslint-disable-line
}
