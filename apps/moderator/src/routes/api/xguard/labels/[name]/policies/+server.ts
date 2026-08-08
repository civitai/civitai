import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { WebhookEndpoint } from '$lib/server/webhook-endpoint';
import { ok, readJson, type EndpointDoc } from '$lib/server/api-guard';
import { labDb } from '$lib/server/xguard-lab';
import { idOf } from '$lib/server/xguard-api';

// Saving is always a NEW version, never an update in place: `eval_run.policy_id` points at a specific
// row, so editing one would silently rewrite what a past run measured.

export const _doc: EndpointDoc = {
  summary: 'List policy versions for a label, or save the edited prose as the next version.',
  params: [
    {
      name: 'policy',
      type: 'string (POST body)',
      required: true,
      description: 'The policy prose.',
    },
    {
      name: 'threshold',
      type: 'number (POST body)',
      required: true,
      description: 'Score at or above which the label fires. 0-1.',
    },
    { name: 'action', type: 'string (POST body)', description: 'Defaults to "Scan".' },
    {
      name: 'note',
      type: 'string (POST body)',
      description: 'Why this revision exists. Shows in run history.',
    },
  ],
  returns:
    'POST returns the created version number and id. Saving does not evaluate — POST /api/xguard/runs next.',
  notes: [
    'Thresholds do not transfer between scanners. A threshold tuned against XGuard means nothing to another one.',
  ],
};

export const GET: RequestHandler = WebhookEndpoint(async (event) => {
  const versions = await labDb
    .selectFrom('label_policy')
    .select(['id', 'version', 'policy', 'threshold', 'action', 'note', 'created_at as createdAt'])
    .where('label', '=', event.params.name)
    .orderBy('version', 'desc')
    .execute();
  return ok({
    label: event.params.name,
    versions: versions.map((v) => ({ ...v, id: idOf(v.id) })),
  });
});

export const POST: RequestHandler = WebhookEndpoint(async (event) => {
  const name = event.params.name;

  const label = await labDb
    .selectFrom('label_def')
    .select(['name'])
    .where('name', '=', name)
    .executeTakeFirst();
  if (!label) error(404, `No label named ${name}`);

  const body = await readJson<{
    policy?: unknown;
    threshold?: unknown;
    action?: unknown;
    note?: unknown;
  }>(event);

  const policy = typeof body.policy === 'string' ? body.policy.trim() : '';
  if (!policy) error(400, 'policy is required');
  const threshold = Number(body.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    error(400, 'threshold must be between 0 and 1');
  }
  const action =
    typeof body.action === 'string' && body.action.trim() ? body.action.trim() : 'Scan';
  const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;

  const latest = await labDb
    .selectFrom('label_policy')
    .select(({ fn }) => fn.max<number>('version').as('v'))
    .where('label', '=', name)
    .executeTakeFirst();
  const version = (latest?.v ?? 0) + 1;

  const created = await labDb
    .insertInto('label_policy')
    .values({ label: name, version, policy, threshold, action, note })
    .returning(['id'])
    .executeTakeFirstOrThrow();

  return ok({ label: name, version, id: idOf(created.id) }, 201);
});
