import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { int4Id } from '$lib/server/query';
import { promptKeyName } from '$lib/text-scan-lab/labels';
import { PROMPT_KEYS, type PromptKey } from '$lib/text-scan-lab/types';
import { LabHarnessError, StalePromptError, putPrompt } from './harness-client';
import { getVersion } from './version';

const baseIdField = z
  .string({ error: 'Reload the page and save again.' })
  .regex(/^(?:[1-9]\d*)?$/, 'Malformed base version.')
  .transform((v) => (v === '' ? null : Number(v)));
const noteField = z
  .string()
  .trim()
  .max(2000, 'The note is too long.')
  .optional()
  .transform((note) => note || undefined);

export const saveSchema = z.object({
  key: z.enum(PROMPT_KEYS),
  content: z
    .string()
    .max(200_000, 'That prompt is too long.')
    .refine((s) => s.trim().length > 0, 'The prompt is empty — write it, or discard the draft.'),
  baseId: baseIdField,
  note: noteField,
});

export const restoreSchema = z.object({
  key: z.enum(PROMPT_KEYS),
  id: int4Id,
  baseId: baseIdField,
  note: noteField,
});

const stale = (key: PromptKey) =>
  fail(409, {
    error: `${promptKeyName(
      key
    )} was saved by someone else after your draft started. Compare the newer version with your draft, then keep your draft or discard it.`,
    stale: key,
  });

async function put(
  key: PromptKey,
  content: string,
  opts: { note?: string; baseId: number | null }
) {
  try {
    const row = await putPrompt(key, content, opts);
    return { saved: { key, id: row.id } };
  } catch (e) {
    if (e instanceof StalePromptError) return stale(key);
    if (e instanceof LabHarnessError)
      return fail(502, {
        error: e.refused
          ? `Saving ${promptKeyName(key)} failed (${e.message}); it was not saved.`
          : `Saving ${promptKeyName(key)} failed (${
              e.message
            }); it may or may not have been saved — reload to check.`,
      });
    throw e;
  }
}

export const savePrompt = (input: z.infer<typeof saveSchema>) =>
  put(input.key, input.content, { note: input.note, baseId: input.baseId });

/** Saves an old version's text as a new version; the text is read by id, never taken from the client. */
export async function restorePrompt(input: z.infer<typeof restoreSchema>) {
  let found: Awaited<ReturnType<typeof getVersion>>;
  try {
    found = await getVersion(input.key, input.id);
  } catch (e) {
    if (e instanceof LabHarnessError)
      return fail(502, { error: `Could not load the versions: ${e.message}` });
    throw e;
  }
  const { version, active } = found;
  if (!version)
    return fail(404, { error: `Version #${input.id} is not among the recent versions.` });
  if (active?.id === version.id || active?.content === version.content)
    return fail(400, { error: 'That text is already the current version.' });
  if ((active?.id ?? null) !== input.baseId) return stale(input.key);
  return put(input.key, version.content, {
    note: input.note ?? `Restored #${version.id}`,
    baseId: input.baseId,
  });
}
