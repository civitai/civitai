import { fail } from '@sveltejs/kit';
import { z } from 'zod';
import type { Actions, PageServerLoad } from './$types';
import { canAccess } from '$lib/server/access';
import { parseForm } from '$lib/server/query';
import { refused } from '$lib/server/text-scan-lab/errors';
import { composeEntities, scanTexts } from '$lib/server/text-scan-lab/harness-client';
import { listSets } from '$lib/server/text-scan-lab/test-sets.service';
import { userIdByUsername } from '$lib/server/users.service';
import { normaliseLabFields } from '$lib/text-scan-lab/compose';
import { parseCheckInput } from '$lib/text-scan-lab/input';
import { ENTITY_TYPE_NAMES } from '$lib/text-scan-lab/labels';
import {
  DEFAULT_HEADING,
  LAB_ENTITY_TYPES,
  LAB_LABELS,
  type LabEntityType,
  type LabField,
  type LabScanResult,
  type LabText,
} from '$lib/text-scan-lab/types';

export const load: PageServerLoad = async ({ locals }) => {
  // Saving posts to the set page's action, which the page grant gates as well.
  const sets =
    locals.grants['textScan.testSet.edit'] && canAccess(locals.user, '/text-scan/test-sets')
      ? await listSets()
      : [];
  return { testSets: sets.map((s) => ({ id: s.id, name: s.name })), wide: true };
};

const PROFILE_TYPES = ['UserProfile', 'User'] as const satisfies readonly LabEntityType[];

const checkSchema = z.object({
  input: z.string().max(200_000, 'That text is too long to judge.'),
  lookupAs: z.enum(LAB_ENTITY_TYPES).catch('Model'),
  judgeAs: z.enum(LAB_ENTITY_TYPES).catch('CommentV2'),
  profileAs: z.enum(PROFILE_TYPES).catch('UserProfile'),
});

type CheckSubject = {
  key: string;
  title: string;
  fields: LabField[];
  entityId: number | null;
  authorId: number | null;
};
type Skipped = { entityId: number; error: string };
type Plan = {
  entityType: LabEntityType;
  subjects: CheckSubject[];
  skipped: Skipped[];
  notice: string | null;
};

export type CheckItemResult = CheckSubject & { current: LabScanResult };

const textPlan = (
  entityType: LabEntityType,
  text: string,
  notice: string | null
): Plan | string => {
  const fields = normaliseLabFields([{ heading: DEFAULT_HEADING[entityType], text }]);
  if (typeof fields === 'string') return fields;
  return {
    entityType,
    subjects: [{ key: 'text', title: 'Your text', fields, entityId: null, authorId: null }],
    skipped: [],
    notice,
  };
};

async function entityPlan(
  entityType: LabEntityType,
  ids: number[],
  title: (id: number) => string
): Promise<Plan> {
  const subjects: CheckSubject[] = [];
  const skipped: Skipped[] = [];
  for (const c of await composeEntities(entityType, ids)) {
    if (c.ok)
      subjects.push({
        key: String(c.entityId),
        title: title(c.entityId),
        fields: c.fields,
        entityId: c.entityId,
        authorId: c.userId,
      });
    else skipped.push({ entityId: c.entityId, error: c.error });
  }
  return { entityType, subjects, skipped, notice: null };
}

/** What to scan, or a refusal to show. Everything here runs before any scan is submitted. */
async function plan(input: z.infer<typeof checkSchema>): Promise<Plan | string> {
  const parsed = parseCheckInput(input.input);
  const named = (type: LabEntityType) => (id: number) => `${ENTITY_TYPE_NAMES[type]} ${id}`;
  switch (parsed.kind) {
    case 'empty':
      return 'Paste a Civitai link, an id, or some text.';
    case 'too-many-ids':
      return `${parsed.count} ids is more than the ${parsed.max} one check can take.`;
    case 'ids':
      return entityPlan(input.lookupAs, parsed.ids, named(input.lookupAs));
    case 'entity':
      return entityPlan(parsed.entityType, parsed.ids, named(parsed.entityType));
    case 'user': {
      const userId = await userIdByUsername(parsed.username);
      if (userId === null) return `No user called "${parsed.username}".`;
      const type = input.profileAs;
      return entityPlan(type, [userId], () => `${ENTITY_TYPE_NAMES[type]} · ${parsed.username}`);
    }
    case 'text':
      return textPlan(input.judgeAs, parsed.text, null);
    case 'unknown-url':
      return textPlan(input.judgeAs, parsed.text, parsed.notice);
    case 'refused':
      return parsed.notice;
  }
}

export const actions: Actions = {
  check: async ({ request }) => {
    const input = parseForm(checkSchema, await request.formData());
    if (typeof input === 'string') return fail(400, { error: input });

    let planned: Plan | string;
    try {
      planned = await plan(input);
    } catch (e) {
      return refused(e);
    }
    if (typeof planned === 'string') return fail(400, { error: planned });
    const { entityType, subjects, skipped, notice } = planned;
    if (!subjects.length)
      return fail(400, {
        error: `Nothing to check: ${skipped.map((s) => `${s.entityId} (${s.error})`).join(', ')}.`,
      });

    const texts: LabText[] = subjects.map(({ key, fields }) => ({ key, fields }));
    try {
      const results = new Map((await scanTexts(entityType, texts)).map((r) => [r.key, r] as const));
      const items: CheckItemResult[] = subjects.map((s) => ({
        ...s,
        current: results.get(s.key) ?? {
          key: s.key,
          ok: false,
          error: 'No result returned for this item.',
        },
      }));
      return {
        checked: true as const,
        entityType,
        labels: LAB_LABELS[entityType],
        notice,
        items,
        skipped,
      };
    } catch (e) {
      return refused(e);
    }
  },
};
