import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { DB as ModeratorDB } from '$lib/server/moderator-db/types';
import { jsonField } from '$lib/server/query';
import type { LabComposedEntity } from '$lib/server/text-scan-lab/harness-client';
import { normaliseLabFields } from '$lib/text-scan-lab/compose';
import { LAB_ENTITY_TYPES, type LabEntityType, type LabField } from '$lib/text-scan-lab/types';
import { parseExpected } from '$lib/text-scan-tests/expected';
import { TEST_SET_LIMITS, WORKSPACES } from '$lib/text-scan-tests/types';
import { idField as id } from './guard';
import { TestSetError, createSet, requireOpenSet, upsertCase } from './store';
const optionalText = (max: number, message: string) =>
  z
    .string()
    .trim()
    .max(max, message)
    .optional()
    .transform((v) => v || undefined);

export const captureSchema = z
  .object({
    setId: id.optional(),
    newSetName: optionalText(TEST_SET_LIMITS.nameChars, 'A set name is at most 100 characters.'),
    workspace: z.enum(WORKSPACES),
    entityType: z.enum(LAB_ENTITY_TYPES),
    entityId: id.optional(),
    fields: jsonField(
      z.array(z.object({ heading: z.string(), text: z.string() })).max(500),
      'Malformed text.'
    ).optional(),
    expected: jsonField(z.unknown(), 'Malformed expectation.'),
    note: optionalText(TEST_SET_LIMITS.noteChars, 'A note is at most 1000 characters.').transform(
      (v) => v ?? null
    ),
    origin: z.enum(['try', 'matches']),
  })
  .refine(
    (v) => v.setId !== undefined || v.newSetName !== undefined,
    'Pick a set or name a new one.'
  )
  .refine((v) => v.entityId !== undefined || v.fields !== undefined, 'There is no text to save.');

export type CaptureInput = z.infer<typeof captureSchema>;
export type ComposeFn = (entityType: LabEntityType, ids: number[]) => Promise<LabComposedEntity[]>;

export async function captureCase(
  deps: { db: Kysely<ModeratorDB>; compose: ComposeFn },
  input: CaptureInput,
  userId: number
): Promise<{
  setId: number;
  caseId: number;
  created: boolean;
  setCreated: boolean;
  rescore: boolean;
}> {
  const expected = parseExpected(input.expected, input.entityType);
  if (typeof expected === 'string') throw new TestSetError(expected, 400);

  let fields: readonly { heading: string; text?: string | null }[];
  let authorId: number | null = null;
  if (input.entityId !== undefined) {
    const [composed] = await deps.compose(input.entityType, [input.entityId]);
    if (!composed?.ok)
      throw new TestSetError(
        `Could not load ${input.entityType} ${input.entityId}: ${composed?.error ?? 'not found'}.`,
        404
      );
    fields = composed.fields satisfies LabField[];
    authorId = composed.userId;
  } else {
    const normalised = normaliseLabFields(input.fields ?? []);
    if (typeof normalised === 'string') throw new TestSetError(normalised, 400);
    if (!normalised.length) throw new TestSetError('A test case needs some text.', 400);
    fields = normalised;
  }

  const set =
    input.setId !== undefined
      ? await requireOpenSet(deps.db, input.setId, input.workspace)
      : await createSet(
          deps.db,
          { name: input.newSetName!, description: null, workspace: input.workspace },
          userId
        );
  const saved = await upsertCase(
    deps.db,
    {
      setId: set.id,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      authorId,
      sourceRef: null,
      fields,
      expected,
      note: input.note,
      origin: input.origin,
    },
    userId
  );
  return {
    setId: set.id,
    caseId: saved.case.id,
    created: saved.created,
    setCreated: input.setId === undefined,
    rescore: saved.rescore,
  };
}
