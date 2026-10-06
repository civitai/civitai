import { error, fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Action, Actions, PageServerLoad } from './$types';
import { requiresGrant } from '$lib/server/access';
import { dbRead } from '$lib/server/db';
import { getModeratorDb } from '$lib/server/moderator-db';
import { jsonField, parseForm, parseQuery } from '$lib/server/query';
import { confirmRequest, type PlannedRun } from '$lib/server/text-scan-lab/confirm';
import { getDraftsByIds, listDrafts } from '$lib/server/text-scan-lab/drafts.service';
import { parseEntityIds } from '$lib/server/text-scan-lab/entity-ids';
import { refused } from '$lib/server/text-scan-lab/errors';
import { purgeDeletedSources } from '$lib/server/text-scan-lab/purge.service';
import {
  MAX_RUN_CASES,
  RunError,
  casesPerSecond,
  compareRuns,
  listRuns,
  prepareRerun,
  prepareRun,
  type RunComparison,
  type StartedRun,
  type TestRun,
} from '$lib/server/text-scan-lab/runs.service';
import {
  MAX_ADD_ENTITIES,
  TestSetError,
  addCase,
  addEntities,
  getSet,
  listCases,
  removeCase,
  updateExpected,
} from '$lib/server/text-scan-lab/test-sets.service';
import { MAX_INT4, usersByIds } from '$lib/server/users.service';
import { estimateSeconds } from '$lib/text-scan-lab/estimate';
import { LAB_ENTITY_TYPES } from '$lib/text-scan-lab/types';

const setIdOf = (raw: string) => {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 && id <= Number.MAX_SAFE_INTEGER ? id : null;
};

const runIdParam = z.coerce
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .optional()
  .catch(undefined);
const compareSchema = z.object({ a: runIdParam, b: runIdParam });

/** What each run ran, by draft id. A working copy is named for its owner; its prompts stay private. */
async function runDraftNames(runs: TestRun[]) {
  const ids = [...new Set(runs.filter((r) => r.draftId !== null).map((r) => r.draftId!))];
  const drafts = await getDraftsByIds(ids);
  const owners = await usersByIds(
    drafts.filter((d) => d.kind === 'working').map((d) => d.createdBy)
  );
  return drafts.map((d) => ({
    id: d.id,
    label:
      d.kind === 'working'
        ? `My changes (${owners.get(d.createdBy)?.username ?? `user ${d.createdBy}`})`
        : `Draft · ${d.name}`,
    updatedAt: d.updatedAt,
  }));
}

export const load: PageServerLoad = async ({ params, url }) => {
  const id = setIdOf(params.id);
  const set = id ? await getSet(id) : null;
  if (!set) error(404, 'No such test set.');
  const q = parseQuery(url, compareSchema);
  await purgeDeletedSources({ moderator: getModeratorDb(), main: dbRead }, set.id);
  const [cases, runs, drafts] = await Promise.all([
    listCases(set.id),
    listRuns(set.id),
    listDrafts(),
  ]);
  let comparison: RunComparison | null = null;
  let compareError: string | null = null;
  if (q.a && q.b) {
    try {
      comparison = await compareRuns(set.id, q.a, q.b);
    } catch (e) {
      if (!(e instanceof RunError)) throw e;
      compareError = e.message;
    }
  }
  return {
    set,
    cases,
    runs,
    runDrafts: await runDraftNames(runs),
    drafts: drafts.map((d) => ({
      id: d.id,
      name: d.name,
      updatedAt: d.updatedAt,
      published: d.publishedAt !== null,
    })),
    comparison,
    compareError,
    maxAddEntities: MAX_ADD_ENTITIES,
    maxRunCases: MAX_RUN_CASES,
    wide: true,
  };
};

const optionalId = z
  .string()
  .regex(/^\d*$/, 'Invalid id.')
  .optional()
  .transform((v) => (v ? Number(v) : null))
  .refine((v) => v === null || (v > 0 && v <= MAX_INT4), 'Invalid id.');
const noteField = z
  .string()
  .trim()
  .max(1000, 'Note is at most 1000 characters.')
  .transform((v) => v || null)
  .optional()
  .default(null);
const caseIdField = z.coerce.number().int().positive();
const fieldsField = jsonField(
  z.array(z.object({ heading: z.string(), text: z.string() }), { error: 'Malformed fields.' })
);
const expectedField = jsonField(z.unknown());

const setAction = <S extends z.ZodType>(
  schema: S,
  run: (setId: number, input: z.infer<S>, userId: number) => Promise<Record<string, unknown>>
) =>
  requiresGrant('textScan.testSet.edit', async ({ request, params, locals }) => {
    const setId = setIdOf(params.id ?? '');
    if (!setId) return fail(404, { error: 'No such test set.' });
    const input = parseForm(schema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });
    try {
      return { success: true, ...(await run(setId, input, locals.user.id)) };
    } catch (e) {
      return refused(e);
    }
  });

const versionField = z.union([
  z.literal('active'),
  z
    .string()
    .regex(/^\d+$/, 'Choose a version to run.')
    .transform(Number)
    .refine((v) => v > 0 && v <= Number.MAX_SAFE_INTEGER, 'Choose a version to run.'),
]);

const confirmedAction =
  <S extends z.ZodType>(
    schema: S,
    prepare: (setId: number, input: z.infer<S>, userId: number) => Promise<PlannedRun<StartedRun>>
  ): Action =>
  async ({ request, params, locals }) => {
    const setId = setIdOf(params.id ?? '');
    if (!setId) return fail(404, { error: 'No such test set.' });
    const form = await request.formData();
    const input = parseForm(schema, form);
    if (typeof input === 'string') return fail(400, { error: input });
    try {
      const planned = await prepare(setId, input, locals.user.id);
      const ask = await confirmRequest(form, planned, async () =>
        estimateSeconds(planned.count, await casesPerSecond(setId))
      );
      if (ask) return ask;
      // Scans after the response; the page polls the run until it finishes.
      const { run } = await planned.execute(locals.user.id);
      return { ran: true as const, runId: run.id, status: run.status };
    } catch (e) {
      return refused(e);
    }
  };

export const actions: Actions = {
  run: confirmedAction(z.object({ version: versionField }), (setId, input, userId) =>
    prepareRun({ setId, version: input.version }, userId)
  ),

  rerunErrors: confirmedAction(
    z.object({ runId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) }),
    (setId, input, userId) => prepareRerun(setId, input.runId, userId)
  ),

  // Also the playground's "Save as test case". An entity case is keyed by its id, so saving one that
  // is already in the set replaces it; free text (no entityId) is always new, and counts as synthetic.
  addCase: setAction(
    z.object({
      entityType: z.enum(LAB_ENTITY_TYPES),
      entityId: optionalId,
      authorId: optionalId,
      fields: fieldsField,
      expected: expectedField,
      note: noteField,
    }),
    async (setId, input, userId) => {
      const { case: saved, created } = await addCase(
        { setId, ...input, synthetic: input.entityId === null },
        userId
      );
      return { caseId: saved.id, created };
    }
  ),

  updateExpected: setAction(
    z.object({ caseId: caseIdField, expected: expectedField, note: noteField }),
    async (setId, input) => {
      await updateExpected(setId, input.caseId, input.expected, input.note);
      return {};
    }
  ),

  removeCase: setAction(z.object({ caseId: caseIdField }), async (setId, input) => {
    await removeCase(setId, input.caseId);
    return {};
  }),

  addEntities: setAction(
    z.object({ entityType: z.enum(LAB_ENTITY_TYPES), ids: z.string() }),
    async (setId, input, userId) => {
      const ids = parseEntityIds(input.ids, MAX_ADD_ENTITIES);
      if (typeof ids === 'string') throw new TestSetError(ids, 400);
      return addEntities(setId, input.entityType, ids, userId);
    }
  ),
};
