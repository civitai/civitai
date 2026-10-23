import { error } from '@sveltejs/kit';
import { z } from 'zod';
import {
  countEvidenceHoldsEnding,
  EVIDENCE_HOLD_ENDING_DAYS,
  listEvidenceHeldOwners,
} from '@civitai/db-queries/evidence-hold';
import { denied } from '$lib/server/access';
import { dbRead } from '$lib/server/db';
import { parseQuery } from '$lib/server/query';
import type { PageServerLoad } from './$types';

const PER_PAGE = 50;

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(500).catch(1),
  ending: z.enum(['1', '0']).optional().catch(undefined),
});

// The page grant alone is not enough: who is held is for csam filers.
export const load: PageServerLoad = async ({ url, locals }) => {
  if (!locals.grants['csam.report.file']) error(403, denied('csam.report.file'));
  const { page, ending } = parseQuery(url, querySchema);
  const { owners: endingCount, earliest } = await countEvidenceHoldsEnding(dbRead);
  // Default to the ending list while anyone is ending, so the badge lands on it.
  const endingOnly = ending === undefined ? endingCount > 0 : ending === '1';
  const offset = (page - 1) * PER_PAGE;
  const { items, hasMore } = await listEvidenceHeldOwners(dbRead, {
    endingOnly,
    limit: PER_PAGE,
    offset,
  });
  return {
    items,
    hasMore,
    page,
    endingOnly,
    endingCount,
    earliest,
    windowDays: EVIDENCE_HOLD_ENDING_DAYS,
    // One timestamp for SSR and hydration, so days-left can't differ between them.
    asOf: Date.now(),
  };
};
