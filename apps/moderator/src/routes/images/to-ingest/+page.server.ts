import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { STUCK_PENDING_MINUTES } from '@civitai/shared/image-ingestion';
import type { Actions, PageServerLoad } from './$types';
import { parseIdList, parseQuery } from '$lib/server/query';
import {
  getImagesPendingIngestion,
  countImagesPendingIngestion,
  getIngestionHealth,
  rescanStuckImages,
  MAX_RESCAN_PER_REQUEST,
  RECENT_PENDING_DAYS,
} from '$lib/server/ingestion.service';
import { withheldRow, withheldRows } from '$lib/server/retracted-media';

const querySchema = z.object({
  cursor: z.coerce.number().int().positive().optional().catch(undefined),
  limit: z.coerce.number().int().min(10).max(200).catch(100),
  view: z.enum(['recent', 'stuck']).catch('recent'),
});

export const load: PageServerLoad = async ({ url, locals }) => {
  const { cursor, limit, view } = parseQuery(url, querySchema);
  const [{ items, nextCursor }, total, health] = await Promise.all([
    getImagesPendingIngestion({ cursor, limit, view }),
    view === 'recent' ? countImagesPendingIngestion() : null,
    getIngestionHealth().catch(() => null),
  ]);
  return {
    wide: true,
    images: await withheldRows(
      items,
      locals.user,
      'to-ingest',
      (i) => i.id,
      (i) => ({
        ...withheldRow(i),
        metadata: null,
      })
    ),
    nextCursor,
    total,
    health,
    view,
    recentDays: RECENT_PENDING_DAYS,
    stuckMinutes: STUCK_PENDING_MINUTES,
    maxRescan: MAX_RESCAN_PER_REQUEST,
  };
};

// Access is enforced globally (hooks.server.ts), as on the sibling ingestion queues.
export const actions: Actions = {
  rescan: async ({ request, locals }) => {
    const form = await request.formData();
    const imageIds =
      form.get('all') === 'true' ? undefined : parseIdList(String(form.get('imageIds') ?? ''));

    const result = await rescanStuckImages({
      imageIds,
      userId: locals.user.id,
      viewer: locals.user,
    });
    if (!result.ok) return fail(400, { error: result.error });
    return { success: true, count: result.count, skipped: result.skipped };
  },
};
