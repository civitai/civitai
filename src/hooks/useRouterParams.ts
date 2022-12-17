import { useRouter } from 'next/router';
import { z } from 'zod';

// TODO Router Params: Add support for zod schema parsing
export function useRouterParams<T = any>(schema: z.ZodSchema<T> | null = null) { //eslint-disable-line
  const router = useRouter();

  if (schema) {
    const params = schema.parse(router.query);
    return params;
  }

  return router.query;
}
