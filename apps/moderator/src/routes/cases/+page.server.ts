import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { requiresGrant } from '$lib/server/access';
import { importBatch, ImportRefusedError, undoImport } from '$lib/server/cases/backlog-import';
import { pauseSends, readBrake, resumeSends } from '$lib/server/cases/brake';
import { caseDataBlocked, casesStoreMessage, listBatches } from '$lib/server/cases/cases.service';
import { parseForm } from '$lib/server/query';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  const brake = await readBrake();
  try {
    const blocked = await caseDataBlocked();
    if (blocked)
      return { batches: [], brake, storeError: blocked, grants: grantsOf(locals.grants) };
    return {
      batches: await listBatches(),
      brake,
      storeError: null,
      grants: grantsOf(locals.grants),
    };
  } catch (e) {
    return {
      batches: [],
      brake,
      storeError: casesStoreMessage(e),
      grants: grantsOf(locals.grants),
    };
  }
};

const grantsOf = (g: App.Locals['grants']) => ({
  act: !!g['cases.act'],
  pii: !!g['cases.pii'],
  unpause: !!g['cases.unpause'],
});

const pauseSchema = z.object({ reason: z.string().trim().min(1, 'Give a reason.').max(300) });
const batchSchema = z.object({ batchId: z.string().regex(/^[a-z0-9-]{3,60}$/, 'Unknown batch.') });

const refused = (scope: string, e: unknown) => {
  if (e instanceof ImportRefusedError) return fail(409, { scope, error: e.message });
  if (e instanceof z.ZodError)
    return fail(400, { scope, error: e.issues[0]?.message ?? 'Invalid file.' });
  return fail(503, { scope, error: casesStoreMessage(e) });
};

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
      return refused('import', e);
    }
  }),
  undo: requiresGrant('cases.act', async ({ request }) => {
    const input = parseForm(batchSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { scope: 'undo', error: input });
    try {
      return { scope: 'undo', ...(await undoImport(input.batchId)) };
    } catch (e) {
      return refused('undo', e);
    }
  }),
};
