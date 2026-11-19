import { error } from '@sveltejs/kit';
import { fetchMergeReportFile, isWorkflowId } from '$lib/server/model-merge-analysis.service';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
  const { workflowId } = params;
  const file = isWorkflowId(workflowId) ? await fetchMergeReportFile(workflowId) : null;
  if (!file) error(404, 'This report is not available.');
  return new Response(file.body, {
    headers: {
      'content-type': file.headers.get('content-type') ?? 'application/json',
      'content-disposition': `attachment; filename="merge-report-${workflowId}.json"`,
      'cache-control': 'no-store',
    },
  });
};
