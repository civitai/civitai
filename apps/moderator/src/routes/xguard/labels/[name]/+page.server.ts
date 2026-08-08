import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireAccess } from '$lib/server/access';
import { getLabDb } from '$lib/server/xguard-lab';
import { env } from '$env/dynamic/private';
import { runEvaluation } from '../../../../../xguard-lab/eval-core';

// Policy editor. Every save is a NEW version, never an update in place: `eval_run.policy_id`
// points at a specific row, so editing one would silently rewrite what a past run measured.

export const load: PageServerLoad = async ({ locals, url, params }) => {
  requireAccess(locals.user, '/xguard');

  const label = await getLabDb()
    .selectFrom('label_def')
    .select(['name', 'description', 'status'])
    .where('name', '=', params.name)
    .executeTakeFirst();
  if (!label) error(404, `No label named ${params.name}`);

  const [versions, runs, truth] = await Promise.all([
    getLabDb()
      .selectFrom('label_policy')
      .select(['id', 'version', 'policy', 'threshold', 'action', 'note', 'created_at as createdAt'])
      .where('label', '=', params.name)
      .orderBy('version', 'desc')
      .execute(),
    getLabDb()
      .selectFrom('eval_run')
      .select([
        'id',
        'policy_label as policyLabel',
        'threshold',
        'tp',
        'fp',
        'tn',
        'fn',
        'precision',
        'recall',
        'note',
        'started_at as startedAt',
      ])
      .where('label', '=', params.name)
      .where('status', '=', 'complete')
      .orderBy('started_at', 'desc')
      .limit(15)
      .execute(),
    getLabDb()
      .selectFrom('human_judgement')
      .select(({ fn }) => [
        fn.count<string>('sample_id').distinct().as('confirmed'),
        fn
          .count<string>('sample_id')
          .distinct()
          .filterWhere('verdict', '=', true)
          .as('positives'),
      ])
      .where('label', '=', params.name)
      .where('excluded_reason', 'is', null)
      .executeTakeFirst(),
  ]);

  return {
    label,
    versions,
    runs,
    groundTruth: {
      confirmed: Number(truth?.confirmed ?? 0),
      positives: Number(truth?.positives ?? 0),
    },
  };
};

export const actions: Actions = {
  // Save the edited prose as the next version. Prose changes need a real evaluation run to mean
  // anything, so this deliberately does not also run one - saving should stay instant.
  save: async ({ request, locals, params }) => {
    requireAccess(locals.user, '/xguard');
    const form = await request.formData();
    const policy = String(form.get('policy') ?? '').trim();
    const threshold = Number(form.get('threshold'));
    const action = String(form.get('action') ?? 'Scan');
    const note = String(form.get('note') ?? '').trim() || null;

    if (!policy) return fail(400, { message: 'Policy text is required' });
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
      return fail(400, { message: 'Threshold must be between 0 and 1' });
    }

    const next = await getLabDb()
      .selectFrom('label_policy')
      .select(({ fn }) => fn.max<number>('version').as('v'))
      .where('label', '=', params.name)
      .executeTakeFirst();
    const version = (next?.v ?? 0) + 1;

    await getLabDb()
      .insertInto('label_policy')
      .values({ label: params.name, version, policy, threshold, action, note })
      .execute();

    return { saved: version };
  },

  // Same code path as the CLI, so an agent iterating on prose and a human clicking here produce
  // comparable numbers.
  evaluate: async ({ request, locals, params }) => {
    requireAccess(locals.user, '/xguard');
    const form = await request.formData();
    const version = Number(form.get('version'));
    if (!Number.isFinite(version)) return fail(400, { message: 'Pick a version to evaluate' });

    const connectionString = env.MODERATOR_DATABASE_URL;
    if (!connectionString) return fail(500, { message: 'MODERATOR_DATABASE_URL is not configured' });

    try {
      const summary = await runEvaluation({
        connectionString,
        label: params.name,
        policyVersion: version,
        note: `from the policy editor`,
      });
      return { evaluated: summary };
    } catch (err) {
      return fail(400, { message: (err as Error).message });
    }
  },
};
