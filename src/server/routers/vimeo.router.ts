import { env } from 'process';
import type { GetByIdStringInput } from '~/server/schema/base.schema';
import { getByIdStringSchema } from '~/server/schema/base.schema';
import { publicProcedure, router } from '~/server/trpc';
import { checkVideoAvailable } from '~/server/vimeo/client';

export const vimeoRouter = router({
  checkVideoAvailable: publicProcedure
    .input(getByIdStringSchema)
    .query(async ({ input }: { input: GetByIdStringInput }) => {
      if (!env.VIMEO_ACCESS_TOKEN) {
        return null;
      }

      return checkVideoAvailable({
        id: input.id,
        accessToken: env.VIMEO_ACCESS_TOKEN,
      });
    }),
});
