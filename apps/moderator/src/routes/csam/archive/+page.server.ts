import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { denied } from '$lib/server/access';
import {
  listArchiveRuns,
  listAwaitingArchive,
  runLogUnavailableMessage,
} from '$lib/server/csam-archive.service';
import { dbRead } from '$lib/server/db';
import { parseQuery } from '$lib/server/query';
import type { PageServerLoad } from './$types';

const PER_PAGE = 50;
const AWAITING_LIMIT = 100;

const querySchema = z.object({
  page: z.coerce.number().int().min(1).max(500).catch(1),
  report: z.coerce.number().int().positive().optional().catch(undefined),
});

// The page grant alone is not enough: who was reported is for csam filers, as on /evidence-holds.
export const load: PageServerLoad = async ({ url, locals }) => {
  if (!locals.grants['csam.report.file']) error(403, denied('csam.report.file'));
  const { page, report } = parseQuery(url, querySchema);
  const [awaiting, runs] = await Promise.all([
    listAwaitingArchive(AWAITING_LIMIT),
    listArchiveRuns({ limit: PER_PAGE, offset: (page - 1) * PER_PAGE, reportId: report }),
  ]);
  const runItems = runs.status === 'ok' ? runs.value.items : [];
  const userIds = [...new Set(runItems.map((r) => r.userId))];
  const users = userIds.length
    ? await dbRead
        .selectFrom('User')
        .select(['id', 'username'])
        .where('id', 'in', userIds)
        .execute()
    : [];
  return {
    awaiting,
    runs: runItems,
    hasMore: runs.status === 'ok' && runs.value.hasMore,
    runLogNotice: runs.status === 'ok' ? null : runLogUnavailableMessage(runs.status),
    usernames: Object.fromEntries(users.map((u) => [u.id, u.username])) as Record<
      number,
      string | null
    >,
    page,
    report: report ?? null,
  };
};
