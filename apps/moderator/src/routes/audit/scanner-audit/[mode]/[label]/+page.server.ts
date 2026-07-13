import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { focusedRun } from '$lib/server/scanner-review.service';
import { isValidMode, modeToScanner } from '$lib/scanner-audit';

export const load: PageServerLoad = async ({ params, url, locals }) => {
  if (!isValidMode(params.mode) || !params.label) error(404, 'Not found');
  const scanner = modeToScanner(params.mode);
  const label = decodeURIComponent(params.label);
  const lookbackParam = Number(url.searchParams.get('lookbackDays'));
  const lookbackDays = Number.isFinite(lookbackParam) && lookbackParam > 0 ? lookbackParam : undefined;

  const run = await focusedRun({
    scanner,
    label,
    lookbackDays,
    limit: 50,
    nearMissGap: 0.05,
    userId: locals.user.id,
    latestVersionOnly: true,
  });

  return { mode: params.mode, scanner, label, fullBleed: true, ...run };
};
