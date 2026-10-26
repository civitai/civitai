import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { reportEntities, type ReportEntity } from '$lib/reports';
import { getReportQueueWorkers } from '$lib/server/reports.service';
import { bounded } from '$lib/server/bounded';
import { logToAxiom } from '$lib/server/axiom';

// Same access as /api/sidebar-last-actioned. A failure is a 503, never `[]`: an empty list reads as
// "nobody worked this queue all week".
export const GET: RequestHandler = async ({ locals, url }) => {
  if (!locals.user) return json(null, { status: 401 });
  const type = url.searchParams.get('type') ?? '';
  if (!(reportEntities as string[]).includes(type)) return json(null, { status: 400 });
  const workers = await bounded(
    () => getReportQueueWorkers(type as ReportEntity),
    3_000,
    (error) => {
      void logToAxiom({
        name: 'report-queue-workers',
        type: 'error',
        message: 'queue history lookup failed',
        details: { type, error: error instanceof Error ? error.message : String(error) },
      });
    }
  );
  if (!workers) return json(null, { status: 503 });
  return json(workers);
};
