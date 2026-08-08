import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { defineWebhookEndpoint } from '$lib/server/api-endpoint';
import { getLabDb } from '$lib/server/xguard-lab';
import { idOf } from '$lib/server/xguard-api';

export const GET = defineWebhookEndpoint({
  summary: 'One label: its policy versions, highlight terms, and how much ground truth it has.',
  input: z.object({
    name: z.string().min(1).describe('Label name, e.g. AgeAsserted.'),
  }),
  returns: 'label, versions (newest first, with full policy prose), terms, groundTruth counts.',
  handler: async ({ name }) => {
    const label = await getLabDb()
      .selectFrom('label_def')
      .select(['name', 'description', 'status'])
      .where('name', '=', name)
      .executeTakeFirst();
    if (!label) error(404, `No label named ${name}`);

    const [versions, terms, truth] = await Promise.all([
      getLabDb()
        .selectFrom('label_policy')
        .select([
          'id',
          'version',
          'policy',
          'threshold',
          'action',
          'note',
          'created_at as createdAt',
        ])
        .where('label', '=', name)
        .orderBy('version', 'desc')
        .execute(),
      getLabDb()
        .selectFrom('label_term')
        .select(['term', 'kind', 'note'])
        .where('label', '=', name)
        .orderBy('term')
        .execute(),
      getLabDb()
        .selectFrom('human_judgement')
        .select(({ fn }) => [
          fn.count<string>('sample_id').distinct().as('confirmed'),
          fn.count<string>('sample_id').distinct().filterWhere('verdict', '=', true).as('positives'),
        ])
        .where('label', '=', name)
        .where('excluded_reason', 'is', null)
        .executeTakeFirst(),
    ]);

    return {
      label,
      versions: versions.map((v) => ({ ...v, id: idOf(v.id) })),
      terms,
      groundTruth: {
        confirmed: Number(truth?.confirmed ?? 0),
        positives: Number(truth?.positives ?? 0),
      },
    };
  },
});
