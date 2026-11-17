import { error, fail } from '@sveltejs/kit';
import { requiresGrant } from '$lib/server/access';
import { batchCounts, ImportRefusedError, importSentJsonl } from '$lib/server/cases/backlog-import';
import { readBrake } from '$lib/server/cases/brake';
import {
  batchPreview,
  caseDataBlocked,
  casesStoreMessage,
  isBatchRunning,
  STALE_SENDING_MS,
  startBatchSend,
} from '$lib/server/cases/cases.service';
import type { Actions, PageServerLoad } from './$types';

const BATCH_ID = /^[a-z0-9-]{3,60}$/;

export const load: PageServerLoad = async ({ params, locals }) => {
  if (!BATCH_ID.test(params.batchId)) error(404, 'Unknown batch.');
  const brake = await readBrake();
  try {
    const blocked = await caseDataBlocked();
    if (blocked) throw Object.assign(new Error(blocked), { blocked });
    const [counts, running] = await Promise.all([
      batchCounts(params.batchId),
      isBatchRunning(params.batchId),
    ]);
    // Recipients and bodies are personal data: shown only with cases.pii, and each read is recorded.
    const preview = locals.grants['cases.pii']
      ? await batchPreview(params.batchId, { actorId: locals.user.id })
      : null;
    return {
      batchId: params.batchId,
      counts,
      running,
      brake,
      preview,
      staleBefore: Date.now() - STALE_SENDING_MS,
      canAct: !!locals.grants['cases.act'],
      storeError: null,
    };
  } catch (e) {
    return {
      batchId: params.batchId,
      counts: [],
      running: false,
      brake,
      preview: null,
      staleBefore: 0,
      canAct: false,
      storeError: (e as { blocked?: string }).blocked ?? casesStoreMessage(e),
    };
  }
};

export const actions: Actions = {
  send: requiresGrant('cases.act', async ({ params }) => {
    const batchId = params.batchId ?? '';
    if (!BATCH_ID.test(batchId)) return fail(404, { scope: 'send', error: 'Unknown batch.' });
    const brake = await readBrake();
    if (brake.paused) return fail(409, { scope: 'send', error: 'Sends are paused.' });
    const blocked = await caseDataBlocked();
    if (blocked) return fail(503, { scope: 'send', error: blocked });
    return { scope: 'send', started: (await startBatchSend(batchId)) === 'started' };
  }),
  importSent: requiresGrant('cases.act', async ({ params, request, locals }) => {
    const file = (await request.formData()).get('file');
    if (!(file instanceof File) || !file.size)
      return fail(400, { scope: 'importSent', error: 'Choose the sent.jsonl file.' });
    try {
      const result = await importSentJsonl(params.batchId ?? '', await file.text(), {
        actorId: locals.user.id,
      });
      return { scope: 'importSent', ...result };
    } catch (e) {
      if (e instanceof ImportRefusedError)
        return fail(400, { scope: 'importSent', error: e.message });
      return fail(503, { scope: 'importSent', error: casesStoreMessage(e) });
    }
  }),
};
