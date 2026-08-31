import type { RequestHandler } from './$types';
import { getCreatorVersionsForCsv } from '$lib/server/models';
import { buildFeeCsv } from '$lib/server/monetization/fee-csv';

// CSV export of the creator's monetization config — licensing fee, paid-access gate and donation goal per
// version — filtered to match the current /models view.
export const GET: RequestHandler = async ({ locals, url }) => {
  const p = url.searchParams;
  const status = p.get('status');
  const rows = await getCreatorVersionsForCsv({
    userId: locals.user.id,
    q: p.get('q')?.trim() || undefined,
    fee:
      p.get('fee') === 'set' || p.get('fee') === 'off'
        ? (p.get('fee') as 'set' | 'off')
        : undefined,
    baseModel: p.get('bm')?.trim() || undefined,
    type: p.get('mt')?.trim() || undefined,
    status:
      status === 'all' || status === 'published' || status === 'draft'
        ? (status as 'all' | 'published' | 'draft')
        : undefined,
    access: p.get('access') === '1',
  });
  return new Response(buildFeeCsv(rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="model-monetization.csv"',
    },
  });
};
