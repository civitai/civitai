import { fail, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { parseForm } from '$lib/server/query';
import {
  promptChangesField,
  ruleOverridesField,
  validatePromptChanges,
} from '$lib/server/text-scan-lab/try';
import { requestCookie } from '$lib/server/user-actions.service';
import type { Workspace } from '$lib/text-scan-tests/types';
import { runsDeps } from './deps';
import { refusal, requireWorkspace } from './guard';
import { cancelRun, quoteRun, startRun, type DraftInput } from './runs';
import { TestSetError, getSet } from './store';

const id = z.coerce.number().int().positive().max(2_147_483_647);

const runSchema = z.object({
  setId: id,
  prompts: promptChangesField.optional().default({}),
  rules: ruleOverridesField.optional().default([]),
  stamp: z.string().max(128).optional(),
});
type RunForm = z.infer<typeof runSchema>;

const cancelSchema = z.object({ setId: id, runId: id });

function draftOf(input: RunForm): DraftInput | null {
  const prompts = validatePromptChanges(input.prompts);
  return Object.keys(prompts).length || input.rules.length ? { prompts, rules: input.rules } : null;
}

export async function quoteAction(event: RequestEvent, workspace: Workspace) {
  const input = parseForm(runSchema, await event.request.formData());
  if (typeof input === 'string') return fail(400, { error: input });
  try {
    requireWorkspace(event.locals.user, workspace);
    const draft = draftOf(input);
    return { quote: await quoteRun(runsDeps(requestCookie()), input.setId, workspace, draft) };
  } catch (e) {
    return refusal(e);
  }
}

export async function startAction(event: RequestEvent, workspace: Workspace) {
  const input = parseForm(runSchema, await event.request.formData());
  if (typeof input === 'string') return fail(400, { error: input });
  if (!input.stamp) return fail(400, { error: 'Check the estimate before starting.' });
  try {
    requireWorkspace(event.locals.user, workspace);
    const draft = draftOf(input);
    const started = await startRun(
      runsDeps(requestCookie()),
      { setId: input.setId, workspace, draft, stamp: input.stamp },
      event.locals.user.id
    );
    return { started };
  } catch (e) {
    return refusal(e);
  }
}

export async function cancelAction(event: RequestEvent) {
  const input = parseForm(cancelSchema, await event.request.formData());
  if (typeof input === 'string') return fail(400, { error: input });
  try {
    const deps = runsDeps(requestCookie());
    const set = await getSet(deps.db, input.setId);
    if (!set) throw new TestSetError(`Test set ${input.setId} not found.`, 404);
    requireWorkspace(event.locals.user, set.workspace);
    const cancelled = await cancelRun(
      deps,
      input.setId,
      input.runId,
      event.locals.user.id,
      !!event.locals.grants['textScan.testSets.edit']
    );
    return { cancelled };
  } catch (e) {
    return refusal(e);
  }
}
