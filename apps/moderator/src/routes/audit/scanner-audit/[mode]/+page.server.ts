import { error } from '@sveltejs/kit';
import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { listScans, getLabelReviewStats } from '$lib/server/scanner-review.service';
import { isValidMode, modeToScanner } from '$lib/scanner-audit';
import { parseQuery } from '$lib/server/query';

const LIMIT = 50;

const querySchema = z.object({
  page: z.coerce.number().int().min(1).catch(1),
  view: z.enum(['triggered', 'near-miss']).catch('triggered'),
  label: z.string().trim().catch(''),
  version: z.string().trim().catch(''),
});

export const load: PageServerLoad = async ({ params, url, locals }) => {
  if (!isValidMode(params.mode)) error(404, 'Unknown scanner mode');
  const scanner = modeToScanner(params.mode);
  const { page, view, label, version } = parseQuery(url, querySchema);

  const [data, stats] = await Promise.all([
    listScans(
      {
        scanner,
        view,
        label: label || undefined,
        version: version || undefined,
        nearMissGap: 0.05,
        limit: LIMIT,
        offset: (page - 1) * LIMIT,
        latestVersionOnly: true,
      },
      locals.user.id
    ),
    getLabelReviewStats({ scanner }),
  ]);

  return { mode: params.mode, view, label, version, page, limit: LIMIT, ...data, stats };
};
