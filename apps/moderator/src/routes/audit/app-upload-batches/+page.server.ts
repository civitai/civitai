import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { int4Id, parseQueryKeys } from '$lib/server/query';
import { listUploadBatches } from '$lib/server/app-upload-batches.service';

const querySchema = z.object({
  userId: int4Id.optional().catch(undefined),
  appBlockId: z.string().trim().max(64).optional().catch(undefined),
  cursor: int4Id.optional().catch(undefined),
});

export const load: PageServerLoad = async ({ url }) => {
  const { userId, appBlockId, cursor } = parseQueryKeys(url, querySchema);
  return {
    filter: { userId: userId ?? null, appBlockId: appBlockId || null },
    list: await listUploadBatches({ userId, appBlockId: appBlockId || undefined, cursor }),
  };
};
