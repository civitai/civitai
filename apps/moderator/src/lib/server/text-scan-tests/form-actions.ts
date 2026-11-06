import { fail, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { recordModActivity } from '$lib/server/mod-activity';
import { getModeratorDb } from '$lib/server/moderator-db';
import { jsonField, parseForm } from '$lib/server/query';
import { promptChangesField, validatePromptChanges } from '$lib/server/text-scan-lab/try';
import { requestCookie } from '$lib/server/user-actions.service';
import type { Workspace } from '$lib/text-scan-tests/types';
import { runsDeps } from './deps';
import { idField as id, refusal, requireWorkspace } from './guard';
import { refreshSetTotals } from './totals';
import { cancelRun, quoteRun, rerunErrors, startRun, type DraftInput, type RunsDeps } from './runs';
import {
  TestSetError,
  archiveSet,
  getCase,
  removeCase,
  requireSet,
  updateExpectation,
} from './store';

type Db = RunsDeps['db'];

const runSchema = z.object({
  setId: id,
  prompts: promptChangesField.optional().default({}),
  stamp: z.string().max(128).optional(),
});
type RunForm = z.infer<typeof runSchema>;

const runRef = z.object({ setId: id, runId: id });
const caseRef = z.object({ setId: id, caseId: id });
const editSchema = caseRef.extend({
  expected: jsonField(z.unknown(), 'Malformed expectation.'),
  note: z
    .string()
    .trim()
    .max(1000, 'A note is at most 1000 characters.')
    .optional()
    .transform((v) => v || null),
});

function draftOf(input: RunForm): DraftInput | null {
  const prompts = validatePromptChanges(input.prompts);
  return Object.keys(prompts).length ? { prompts } : null;
}

async function openSetFor(event: RequestEvent, db: Db, setId: number) {
  requireWorkspace(event.locals.user, (await requireSet(db, setId)).workspace);
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
  const input = parseForm(runRef, await event.request.formData());
  if (typeof input === 'string') return fail(400, { error: input });
  try {
    const deps = runsDeps(requestCookie());
    await openSetFor(event, deps.db, input.setId);
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

export async function editCaseAction(event: RequestEvent) {
  const input = parseForm(editSchema, await event.request.formData());
  if (typeof input === 'string') return fail(400, { error: input });
  const userId = event.locals.user.id;
  try {
    const db = getModeratorDb();
    await openSetFor(event, db, input.setId);
    const updated = await updateExpectation(
      db,
      input.setId,
      input.caseId,
      input.expected,
      input.note,
      userId
    );
    await recordModActivity({
      userId,
      entityType: updated.entityType,
      entityId: updated.entityId,
      activity: 'textScan.testCase.relabel',
    });
    await refreshSetTotals(db, input.setId);
    return { success: true, caseId: updated.id };
  } catch (e) {
    return refusal(e);
  }
}

export async function removeCaseAction(event: RequestEvent) {
  const input = parseForm(caseRef, await event.request.formData());
  if (typeof input === 'string') return fail(400, { error: input });
  const userId = event.locals.user.id;
  try {
    const db = getModeratorDb();
    await openSetFor(event, db, input.setId);
    const existing = await getCase(db, input.setId, input.caseId);
    if (!existing) throw new TestSetError(`Test case ${input.caseId} not found in this set.`, 404);
    await removeCase(db, input.setId, input.caseId);
    await recordModActivity({
      userId,
      entityType: existing.entityType,
      entityId: existing.entityId,
      activity: 'textScan.testCase.remove',
    });
    await refreshSetTotals(db, input.setId);
    return { success: true };
  } catch (e) {
    return refusal(e);
  }
}

export async function archiveSetAction(event: RequestEvent) {
  const input = parseForm(z.object({ setId: id }), await event.request.formData());
  if (typeof input === 'string') return fail(400, { error: input });
  try {
    const db = getModeratorDb();
    await openSetFor(event, db, input.setId);
    await archiveSet(db, input.setId);
    await recordModActivity({
      userId: event.locals.user.id,
      entityType: 'textScanTestSet',
      entityId: input.setId,
      activity: 'textScan.testSet.archive',
    });
    return { success: true };
  } catch (e) {
    return refusal(e);
  }
}

export async function rerunAction(event: RequestEvent) {
  const input = parseForm(runRef, await event.request.formData());
  if (typeof input === 'string') return fail(400, { error: input });
  try {
    const deps = runsDeps(requestCookie());
    await openSetFor(event, deps.db, input.setId);
    const started = await rerunErrors(deps, input.setId, input.runId, event.locals.user.id);
    return { started };
  } catch (e) {
    return refusal(e);
  }
}
