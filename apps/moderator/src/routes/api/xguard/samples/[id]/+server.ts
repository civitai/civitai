import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { defineWebhookEndpoint } from '$lib/server/api-endpoint';
import { labDb } from '$lib/server/xguard-lab';
import { idOf } from '$lib/server/xguard-api';

export const GET = defineWebhookEndpoint({
  summary: 'One sample with every judgement made about it, machine and human.',
  input: z.object({
    // Kept as a string: the column is a bigint, and a JS number would round ids past 2^53.
    id: z.string().regex(/^\d+$/, 'id must be numeric').describe('Sample id.'),
  }),
  returns:
    'The prompt, its live scores, machine judgements (with highlight spans) and human judgements.',
  notes: [
    'Human judgements are readable here and writable only in the browser — see the docs page for why.',
  ],
  handler: async ({ id }) => {
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

    return {
      sample: { ...sample, id: idOf(sample.id) },
      machineJudgements: machine.map((m) => ({ ...m, id: idOf(m.id) })),
      humanJudgements: human.map((h) => ({ ...h, id: idOf(h.id) })),
    };
  },
});
