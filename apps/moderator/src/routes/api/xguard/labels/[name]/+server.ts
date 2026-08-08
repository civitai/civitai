import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { WebhookEndpoint } from '$lib/server/webhook-endpoint';
import { ok, type EndpointDoc } from '$lib/server/api-guard';
import { labDb } from '$lib/server/xguard-lab';
import { idOf } from '$lib/server/xguard-api';

export const _doc: EndpointDoc = {
  summary: 'One label: its policy versions, highlight terms, and how much ground truth it has.',
  params: [
    { name: 'name', type: 'path', required: true, description: 'Label name, e.g. AgeAsserted.' },
  ],
  returns: 'label, versions (newest first, with full policy prose), terms, groundTruth counts.',
};

export const GET: RequestHandler = WebhookEndpoint(async (event) => {
  const name = event.params.name;

  const label = await labDb
    .selectFrom('label_def')
    .select(['name', 'description', 'status'])
    .where('name', '=', name)
    .executeTakeFirst();
  if (!label) error(404, `No label named ${name}`);

  const [versions, terms, truth] = await Promise.all([
    labDb
      .selectFrom('label_policy')
      .select(['id', 'version', 'policy', 'threshold', 'action', 'note', 'created_at as createdAt'])
      .where('label', '=', name)
      .orderBy('version', 'desc')
      .execute(),
    labDb
      .selectFrom('label_term')
      .select(['term', 'kind', 'note'])
      .where('label', '=', name)
      .orderBy('term')
      .execute(),
    labDb
      .selectFrom('human_judgement')
      .select(({ fn }) => [
        fn.count<string>('sample_id').distinct().as('confirmed'),
        fn.count<string>('sample_id').distinct().filterWhere('verdict', '=', true).as('positives'),
      ])
      .where('label', '=', name)
      .where('excluded_reason', 'is', null)
      .executeTakeFirst(),
  ]);

  return ok({
    label,
    versions: versions.map((v) => ({ ...v, id: idOf(v.id) })),
    terms,
    groundTruth: {
      confirmed: Number(truth?.confirmed ?? 0),
      positives: Number(truth?.positives ?? 0),
    },
  });
});
