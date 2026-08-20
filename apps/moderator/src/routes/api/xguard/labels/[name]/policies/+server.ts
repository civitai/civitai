import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { defineWebhookEndpoint } from '$lib/server/api-endpoint';
import { ok } from '$lib/server/api-guard';
import { getLabDb } from '$lib/server/xguard-lab';
import { idOf } from '$lib/server/xguard-api';

// Saving is always a NEW version, never an update in place: `eval_run.policy_id` points at a specific
// row, so editing one would silently rewrite what a past run measured.

const label = z.object({
  name: z.string().min(1).describe('Label name, from the path.'),
});

export const GET = defineWebhookEndpoint({
  summary: 'List policy versions for a label, newest first.',
  input: label,
  returns: 'Every saved version with its prose, threshold, action and note.',
  handler: async ({ name }) => {
    const versions = await getLabDb()
      .selectFrom('label_policy')
      .select(['id', 'version', 'policy', 'threshold', 'action', 'note', 'created_at as createdAt'])
      .where('label', '=', name)
      .orderBy('version', 'desc')
      .execute();
    return { label: name, versions: versions.map((v) => ({ ...v, id: idOf(v.id) })) };
  },
});

export const POST = defineWebhookEndpoint({
  summary: 'Save the edited prose as the next policy version.',
  input: label.extend({
    policy: z.string().trim().min(1).describe('The policy prose.'),
    threshold: z.coerce
      .number()
      .min(0)
      .max(1)
      .describe('Score at or above which the label fires. 0-1.'),
    action: z.string().trim().min(1).default('Scan').describe('Defaults to "Scan".'),
    note: z
      .string()
      .trim()
      .min(1)
      .nullish()
      .describe('Why this revision exists. Shows in run history.'),
  }),
  returns:
    'The created version number and id. Saving does not evaluate — POST /api/xguard/runs next.',
  notes: [
    'Thresholds do not transfer between scanners. A threshold tuned against XGuard means nothing to another one.',
  ],
  handler: async ({ name, policy, threshold, action, note }) => {
    const known = await getLabDb()
      .selectFrom('label_def')
      .select(['name'])
      .where('name', '=', name)
      .executeTakeFirst();
    if (!known) error(404, `No label named ${name}`);

    const latest = await getLabDb()
      .selectFrom('label_policy')
      .select(({ fn }) => fn.max<number>('version').as('v'))
      .where('label', '=', name)
      .executeTakeFirst();
    const version = (latest?.v ?? 0) + 1;

    const created = await getLabDb()
      .insertInto('label_policy')
      .values({ label: name, version, policy, threshold, action, note: note ?? null })
      .returning(['id'])
      .executeTakeFirstOrThrow();

    return ok({ label: name, version, id: idOf(created.id) }, 201);
  },
});
