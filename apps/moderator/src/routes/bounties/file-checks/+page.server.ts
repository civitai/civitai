import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { RESOLUTION_NOTE_MAX_LENGTH } from '@civitai/shared/resolution-reasons';
import type { Actions, PageServerLoad } from './$types';
import {
  clearEntryFileCheck,
  getBlockedEntryFiles,
  getClearedEntryFiles,
  getStuckEntryFiles,
  reblockEntryFileCheck,
} from '$lib/server/bounty-file-check.service';
import type { JsonResult } from '$lib/server/user-actions.service';
import { parseForm } from '$lib/server/query';

const LIMIT = 100;

export const load: PageServerLoad = async () => {
  const [blocked, stuck, cleared] = await Promise.all([
    getBlockedEntryFiles(LIMIT),
    getStuckEntryFiles(LIMIT),
    getClearedEntryFiles(25),
  ]);
  return { blocked, stuck, cleared, limit: LIMIT };
};

const fileReason = z.object({
  fileId: z.coerce.number().int().positive({ error: 'Missing file id.' }),
  reason: z
    .string({ error: 'A reason is required.' })
    .trim()
    .min(1, { error: 'A reason is required.' })
    .max(RESOLUTION_NOTE_MAX_LENGTH, { error: 'The reason is too long.' }),
});

async function fileAction(
  request: Request,
  send: (fileId: number, reason: string) => Promise<JsonResult>
) {
  const input = parseForm(fileReason, await request.formData());
  if (typeof input === 'string') return fail(400, { error: input });

  const result = await send(input.fileId, input.reason);
  if (!result.ok) return fail(400, { error: result.error, fileId: input.fileId });
  return { success: true, fileId: input.fileId };
}

export const actions = {
  clear: ({ request }) => fileAction(request, clearEntryFileCheck),
  reblock: ({ request }) => fileAction(request, reblockEntryFileCheck),
} satisfies Actions;
