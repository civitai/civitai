import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { WebhookEndpoint } from '$lib/server/webhook-endpoint';
import { ok, type EndpointDoc } from '$lib/server/api-guard';
import { labDb } from '$lib/server/xguard-lab';
import { idOf, requireId } from '$lib/server/xguard-api';

export const _doc: EndpointDoc = {
  summary: 'One sample with every judgement made about it, machine and human.',
  params: [{ name: 'id', type: 'path', required: true, description: 'Sample id.' }],
  returns:
    'The prompt, its live scores, machine judgements (with highlight spans) and human judgements.',
  notes: [
    'Human judgements are readable here and writable only in the browser — see the docs page for why.',
  ],
};

export const GET: RequestHandler = WebhookEndpoint(async (event) => {
  const id = requireId(event.params.id);

  const sample = await labDb
    .selectFrom('sample')
    .select([
      'id',
      'batch',
      'source',
      'user_id as userId',
      'positive_prompt as positivePrompt',
      'negative_prompt as negativePrompt',
      'live_scores as liveScores',
      'prompt_created_at as promptCreatedAt',
      'created_at as createdAt',
    ])
    .where('id', '=', id)
    .executeTakeFirst();
  if (!sample) error(404, `No sample ${id}`);

  const [machine, human] = await Promise.all([
    labDb
      .selectFrom('machine_judgement')
      .select([
        'id',
        'label',
        'source',
        'model',
        'score',
        'verdict',
        'reason',
        'highlights',
        'created_at as createdAt',
      ])
      .where('sample_id', '=', id)
      .orderBy('created_at')
      .execute(),
    labDb
      .selectFrom('human_judgement')
      .select([
        'id',
        'label',
        'agreed',
        'verdict',
        'note',
        'reviewer_id as reviewerId',
        'duration_ms as durationMs',
        'excluded_reason as excludedReason',
        'created_at as createdAt',
      ])
      .where('sample_id', '=', id)
      .orderBy('created_at')
      .execute(),
  ]);

  return ok({
    sample: { ...sample, id: idOf(sample.id) },
    machineJudgements: machine.map((m) => ({ ...m, id: idOf(m.id) })),
    humanJudgements: human.map((h) => ({ ...h, id: idOf(h.id) })),
  });
});
