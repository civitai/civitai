import { useRouter } from 'next/router';
import type { ParsedUrlQueryInput } from 'querystring';
import { useMemo } from 'react';
import type * as z from 'zod';
import { removeEmpty } from '~/utils/object-helpers';
import { safeParseValidKeys } from '~/utils/zod-helpers';

export function useZodRouteParams<TSchema extends z.ZodObject>(schema: TSchema) {
  const { query, pathname, replace } = useRouter();

  return useMemo(() => {
    const data = safeParseValidKeys(schema, query);

    const replaceParams = (params: Partial<z.input<TSchema>>, as?: string) => {
      // Junk already in the URL is dropped; a bad value the caller passes still throws.
      const validQueryKeys = Object.keys(safeParseValidKeys(schema, query));
      const validQuery = Object.fromEntries(validQueryKeys.map((key) => [key, query[key]]));
      const data = removeEmpty(schema.parse({ ...validQuery, ...params }));
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
