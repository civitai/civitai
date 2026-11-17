import { error, fail } from '@sveltejs/kit';
import { requiresGrant } from '$lib/server/access';
import {
  batchCounts,
  importSentJsonl,
  resolveSending,
  retireNotice,
  withdrawNotice,
} from '$lib/server/cases/backlog-import';
import { readBrake } from '$lib/server/cases/brake';
import { caseActionFailure, withCaseData } from '$lib/server/cases/case-routes';
import { BATCH_ID } from '$lib/server/cases/cases.db';
import {
  batchPreview,
  caseDataBlocked,
  isBatchRunning,
  STALE_SENDING_MS,
  startBatchSend,
} from '$lib/server/cases/cases.service';
import { parseForm } from '$lib/server/query';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';

const rowSchema = z.object({ rowId: z.coerce.number().int().positive() });
const withdrawSchema = rowSchema.extend({
  reason: z.string().trim().min(1, 'Give a reason.').max(300),
});
const resolveSchema = z.object({
  rowId: z.coerce.number().int().positive(),
  outcome: z.enum(['sent', 'failed']),
});

export const load: PageServerLoad = async ({ params, locals }) => {
  if (!BATCH_ID.test(params.batchId)) error(404, 'Unknown batch.');
  const canPii = !!locals.grants['cases.pii'];
  const [brake, running, data] = await Promise.all([
    readBrake(),
    isBatchRunning(params.batchId),
    withCaseData(async () => ({
      counts: await batchCounts(params.batchId),
      // Recipients and bodies are personal data: shown only with cases.pii, and each read is recorded.
      // The page polls ./counts while a send runs, so this runs once per visit, not once per poll.
      preview: canPii ? await batchPreview(params.batchId, { actorId: locals.user.id }) : null,
    })),
  ]);
  return {
    batchId: params.batchId,
    brake,
    running,
    counts: data.ok ? data.value.counts : [],
    preview: data.ok ? data.value.preview : null,
    storeError: data.ok ? null : data.message,
    staleBefore: Date.now() - STALE_SENDING_MS,
    canAct: !!locals.grants['cases.act'],
    canPii,
  };
};

export const actions: Actions = {
  send: requiresGrant('cases.act', async ({ params }) => {
    const batchId = params.batchId ?? '';
    if (!BATCH_ID.test(batchId)) return fail(404, { scope: 'send', error: 'Unknown batch.' });
    const brake = await readBrake();
    if (brake.paused) return fail(409, { scope: 'send', error: 'Sends are paused.' });
    const blocked = await caseDataBlocked().catch(() => 'The case tables cannot be reached.');
    if (blocked) return fail(503, { scope: 'send', error: blocked });
    const outcome = await startBatchSend(batchId);
    if (outcome === 'export-outstanding')
      return fail(409, {
        scope: 'send',
        error: 'This batch is out with the fallback sender. Import its sent.jsonl first.',
      });
    return { scope: 'send', started: outcome === 'started' };
  }),
  importSent: requiresGrant('cases.act', async ({ params, request, locals }) => {
    const batchId = params.batchId ?? '';
    if (!BATCH_ID.test(batchId)) return fail(404, { scope: 'importSent', error: 'Unknown batch.' });
    const file = (await request.formData()).get('file');
    if (!(file instanceof File) || !file.size)
      return fail(400, { scope: 'importSent', error: 'Choose the sent.jsonl file.' });
    try {
      const blocked = await caseDataBlocked();
      if (blocked) return fail(503, { scope: 'importSent', error: blocked });
      const result = await importSentJsonl(batchId, await file.text(), { actorId: locals.user.id });
      return { scope: 'importSent', ...result };
    } catch (e) {
      return caseActionFailure('importSent', e);
    }
  }),
  resolve: requiresGrant('cases.act', async ({ params, request, locals }) => {
    const batchId = params.batchId ?? '';
    if (!BATCH_ID.test(batchId)) return fail(404, { scope: 'resolve', error: 'Unknown batch.' });
    const input = parseForm(resolveSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { scope: 'resolve', error: input });
    try {
      const blocked = await caseDataBlocked();
      if (blocked) return fail(503, { scope: 'resolve', error: blocked });
      const result = await resolveSending(batchId, input.rowId, input.outcome, {
        actorId: locals.user.id,
      });
      return { scope: 'resolve', ...result };
    } catch (e) {
      return caseActionFailure('resolve', e);
    }
  }),
  retire: requiresGrant('cases.act', async ({ params, request, locals }) => {
    const batchId = params.batchId ?? '';
    if (!BATCH_ID.test(batchId)) return fail(404, { scope: 'retire', error: 'Unknown batch.' });
    const input = parseForm(rowSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { scope: 'retire', error: input });
    try {
      const blocked = await caseDataBlocked();
      if (blocked) return fail(503, { scope: 'retire', error: blocked });
      return {
        scope: 'retire',
        ...(await retireNotice(batchId, input.rowId, { actorId: locals.user.id })),
      };
    } catch (e) {
      return caseActionFailure('retire', e);
    }
  }),
  withdraw: requiresGrant('cases.act', async ({ params, request, locals }) => {
    const batchId = params.batchId ?? '';
    if (!BATCH_ID.test(batchId)) return fail(404, { scope: 'withdraw', error: 'Unknown batch.' });
    const input = parseForm(withdrawSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { scope: 'withdraw', error: input });
    try {
      const blocked = await caseDataBlocked();
      if (blocked) return fail(503, { scope: 'withdraw', error: blocked });
      return {
        scope: 'withdraw',
        ...(await withdrawNotice(batchId, input.rowId, input.reason, { actorId: locals.user.id })),
      };
    } catch (e) {
      return caseActionFailure('withdraw', e);
    }
  }),
};
