import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { RESOLUTION_NOTE_MAX_LENGTH } from '@civitai/shared/resolution-reasons';
import type { Actions, PageServerLoad } from './$types';
import {
  clearEntryFileCheck,
  getBlockedEntryFiles,
  getClearedEntryFiles,
  getStuckEntryFiles,
} from '$lib/server/bounty-file-check.service';
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

export const actions = {
  clear: async ({ request }) => {
    const input = parseForm(
      z.object({
        fileId: z.coerce.number().int().positive({ error: 'Missing file id.' }),
        reason: z
          .string({ error: 'A reason is required.' })
          .trim()
          .min(1, { error: 'A reason is required.' })
          .max(RESOLUTION_NOTE_MAX_LENGTH, { error: 'The reason is too long.' }),
      }),
      await request.formData()
    );
    if (typeof input === 'string') return fail(400, { error: input });

    const result = await clearEntryFileCheck(input.fileId, input.reason);
    if (!result.ok) return fail(400, { error: result.error, fileId: input.fileId });
    return { success: true, fileId: input.fileId };
  },
} satisfies Actions;
