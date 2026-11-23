import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { requiresGrant } from '$lib/server/access';
import { importBatch, undoImport } from '$lib/server/cases/backlog-import';
import { pauseSends, readBrake, resumeSends } from '$lib/server/cases/brake';
import { caseActionFailure, withCaseData } from '$lib/server/cases/case-routes';
import { BATCH_ID } from '$lib/server/cases/cases.db';
import { caseDataBlocked, listBatches, listFiledCases } from '$lib/server/cases/cases.service';
import { parseForm } from '$lib/server/query';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  const [brake, batches, filed] = await Promise.all([
    readBrake(),
    withCaseData(() => listBatches()),
    withCaseData(() => listFiledCases()),
  ]);
  return {
    brake,
    batches: batches.ok ? batches.value : [],
    filed: filed.ok ? filed.value : [],
    storeError: batches.ok ? (filed.ok ? null : filed.message) : batches.message,
    grants: {
      act: !!locals.grants['cases.act'],
      pii: !!locals.grants['cases.pii'],
      unpause: !!locals.grants['cases.unpause'],
    },
  };
};

const pauseSchema = z.object({ reason: z.string().trim().min(1, 'Give a reason.').max(300) });
const batchSchema = z.object({ batchId: z.string().regex(BATCH_ID, 'Unknown batch.') });

export const actions: Actions = {
  pause: requiresGrant('cases.act', async ({ request, locals }) => {
    const input = parseForm(pauseSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { scope: 'pause', error: input });
    await pauseSends(locals.user.id, input.reason);
    return { scope: 'pause' };
  }),
  resume: requiresGrant('cases.unpause', async () => {
    await resumeSends();
    return { scope: 'resume' };
  }),
  import: requiresGrant('cases.act', async ({ request, locals }) => {
    const file = (await request.formData()).get('file');
    if (!(file instanceof File) || !file.size)
      return fail(400, { scope: 'import', error: 'Choose the batch file.' });
    let raw: unknown;
    try {
      raw = JSON.parse(await file.text());
    } catch {
      return fail(400, { scope: 'import', error: 'The file is not JSON.' });
    }
    try {
      const blocked = await caseDataBlocked();
      if (blocked) return fail(503, { scope: 'import', error: blocked });
      return { scope: 'import', ...(await importBatch(raw, { actorId: locals.user.id })) };
    } catch (e) {
      return caseActionFailure('import', e);
    }
  }),
  undo: requiresGrant('cases.act', async ({ request, locals }) => {
    const input = parseForm(batchSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { scope: 'undo', error: input });
    try {
      const blocked = await caseDataBlocked();
      if (blocked) return fail(503, { scope: 'undo', error: blocked });
      return { scope: 'undo', ...(await undoImport(input.batchId, { actorId: locals.user.id })) };
    } catch (e) {
      return caseActionFailure('undo', e);
    }
  }),
};
