import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { requiresGrant } from '$lib/server/access';
import { parseForm, parseQuery } from '$lib/server/query';
import {
  LabHarnessError,
  getPrompts,
  type LabPrompts,
} from '$lib/server/text-scan-lab/harness-client';
import { publishChanges } from '$lib/server/text-scan-lab/publish';
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

const restoreSchema = z.object({
  key: z.enum(PROMPT_KEYS),
  id: z.coerce.number().int().positive(),
  /** The version the moderator saw as current; publishing refuses when it has moved on. */
  activeId: z.coerce.number().int().positive(),
  note: z.string().trim().min(1, 'A note is required.').max(2000),
});

export const actions: Actions = {
  /** Puts an old version's text live as a new version; the text comes from the harness, never the client. */
  restore: requiresGrant('textScan.prompt.publish', async ({ request }) => {
    const input = parseForm(restoreSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });

    let prompts: LabPrompts;
    try {
      prompts = await getPrompts(input.key);
    } catch (e) {
      const why = e instanceof LabHarnessError ? e.message : 'unexpected error';
      return fail(502, { error: `Could not load the versions: ${why}` });
    }
    const version = prompts.history?.find((v) => v.id === input.id && v.key === input.key);
    if (!version)
      return fail(404, { error: `Version #${input.id} is not among the recent versions.` });
    const active = prompts.active[input.key];
    if (active?.id === version.id || active?.content === version.content)
      return fail(400, { error: 'That text is already the current version.' });

    return publishChanges({
      prompts: { [input.key]: version.content },
      activeIds: { [input.key]: input.activeId },
      note: input.note,
    });
  }),
};
