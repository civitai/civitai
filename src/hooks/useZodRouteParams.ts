import { useRouter } from 'next/router';
import { useMemo } from 'react';
import { z } from 'zod';
import { removeEmpty } from '~/utils/object-helpers';

export function useZodRouteParams<TSchema extends z.AnyZodObject>(schema: TSchema) {
  const { query, pathname, replace } = useRouter();

  return useMemo(() => {
    const result = schema.safeParse(query);
    const data = result.success ? result.data : {};

    const replaceParams = (params: Partial<z.infer<TSchema>>) => {
      replace({ pathname, query: removeEmpty({ ...query, ...params }) }, undefined, {
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
