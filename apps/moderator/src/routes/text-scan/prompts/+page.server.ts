import { z } from 'zod';
import type { PageServerLoad } from './$types';
import { parseQuery } from '$lib/server/query';
import {
  LabHarnessError,
  getPrompts,
  type LabPrompts,
} from '$lib/server/text-scan-lab/harness-client';
import { usersByIds } from '$lib/server/users.service';
import { PROMPT_KEYS } from '$lib/text-scan-lab/types';

const querySchema = z.object({ key: z.enum(PROMPT_KEYS).catch('base') });

export const load: PageServerLoad = async ({ url }) => {
  const q = parseQuery(url, querySchema);
  const prompts = await getPrompts(q.key).then(
    (p): { ok: true; value: LabPrompts } => ({ ok: true, value: p }),
    (e: unknown) => ({
      ok: false as const,
      error: `Could not load prompts: ${
        e instanceof LabHarnessError ? e.message : 'unexpected error'
      }`,
    })
  );
  const authorIds = prompts.ok
    ? (prompts.value.history ?? []).flatMap((v) => (v.createdById == null ? [] : [v.createdById]))
    : [];
  const authors = Object.fromEntries(
    [...(await usersByIds(authorIds))].map(([id, u]) => [id, u.username ?? 'unknown'])
  );
  return { key: q.key, prompts, authors };
};
