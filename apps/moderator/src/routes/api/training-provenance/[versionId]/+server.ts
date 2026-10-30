import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireIdParam } from '$lib/server/api-guard';
import { getTrainingProvenance } from '$lib/server/training-provenance.service';

/**
 * Its own endpoint rather than part of the page load: the ClickHouse lookup is per-workflow, so folding
 * it into the training-models list would run one query per card. On demand, one model at a time, is what
 * the window bound in the service is sized for.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
  // Both training pages reach this and are granted separately, so either grant admits.
  const versionId = requireIdParam(
    locals,
    params.versionId,
    ['/audit/training-data', '/audit/training-models'],
    'versionId'
  );

  return json(await getTrainingProvenance(versionId));
};
