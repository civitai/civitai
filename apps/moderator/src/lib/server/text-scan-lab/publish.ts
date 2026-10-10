import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import { jsonField } from '$lib/server/query';
import { LabError } from './errors';
import { LabHarnessError, getPrompts, putPrompt, type LabPrompts } from './harness-client';
import { blankPromptKeys, describeBlankPrompts, promptKeyName } from '$lib/text-scan-lab/labels';
import { PROMPT_KEYS, type PromptChanges, type PromptKey } from '$lib/text-scan-lab/types';

const isPromptKey = (key: string): key is PromptKey =>
  (PROMPT_KEYS as readonly string[]).includes(key);

/** A changed key overrides its prompt, so a blank one would scan or publish an empty prompt: refused,
 *  never dropped. Unknown keys are refused first, so a blank one is never named as a prompt it is not. */
export function validatePromptChanges(prompts: Record<string, unknown>): PromptChanges {
  const unknownKeys = Object.keys(prompts).filter((k) => !isPromptKey(k));
  if (unknownKeys.length)
    throw new LabError(
      `Unknown prompt key ${unknownKeys.join(', ')} — allowed: ${PROMPT_KEYS.join(', ')}.`,
      400
    );
  const blank = blankPromptKeys(prompts);
  if (blank.length) throw new LabError(describeBlankPrompts(blank), 400);
  return prompts as PromptChanges;
}

export const promptChangesField = jsonField(
  z.record(z.string(), z.unknown(), { error: 'Malformed prompts.' }),
  'Malformed prompts.'
);

export const publishSchema = z.object({
  prompts: promptChangesField,
  note: z.string().trim().min(1, 'A publish note is required.').max(2000),
  /** Per changed key, the version the change was written against; null where there was none. */
  activeIds: jsonField(
    z.record(z.string(), z.number().int().nullable(), { error: 'Malformed versions.' }),
    'Malformed versions.'
  ),
});

const names = (keys: readonly PromptKey[]) => keys.map(promptKeyName).join(', ');

/**
 * Each key is its own prompt version, published one after another. Nothing rolls back: versions are
 * append-only, and putting the previous text back is the rollback. A failure therefore names every key
 * that did go live.
 */
export async function publishChanges(input: z.infer<typeof publishSchema>) {
  let changes: PromptChanges;
  try {
    changes = validatePromptChanges(input.prompts);
  } catch (e) {
    if (e instanceof LabError) return fail(e.status, { error: e.message });
    throw e;
  }
  const keys = PROMPT_KEYS.filter((k) => k in changes);
  if (!keys.length) return fail(400, { error: 'There are no changes to publish.' });
  if (keys.some((k) => input.activeIds[k] === undefined))
    return fail(400, { error: 'Reload the page and publish again.' });

  let active: LabPrompts['active'];
  try {
    active = (await getPrompts()).active;
  } catch (e) {
    const why = e instanceof LabHarnessError ? e.message : 'unexpected error';
    return fail(502, { error: `Could not load the current prompts: ${why}` });
  }

  const moved = keys.filter((k) => (active[k]?.id ?? null) !== input.activeIds[k]);
  if (moved.length)
    return fail(409, {
      error: `Someone published a newer version of ${names(
        moved
      )} after your change was written. Review the newer version first: open the change on Check, compare it, then keep your text or discard it.`,
    });

  const published: PromptKey[] = [];
  for (const key of keys) {
    try {
      await putPrompt(key, changes[key]!, input.note);
      published.push(key);
    } catch (e) {
      const why = e instanceof LabHarnessError ? e.message : 'unexpected error';
      return fail(502, {
        error:
          `Publishing ${promptKeyName(key)} failed (${why}); it may or may not have gone live — ` +
          'check Versions. ' +
          (published.length
            ? `Already published: ${names(published)}; the rest stay in your changes.`
            : 'Nothing was published.'),
        published,
      });
    }
  }
  return { success: true as const, published };
}
