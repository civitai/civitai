import type { RequestHandler } from './$types';
import { requireXguardToken, ok, type EndpointDoc } from '$lib/server/api-guard';
import { labDb } from '$lib/server/xguard-lab';

export const _doc: EndpointDoc = {
  summary:
    'Every label, with how much ground truth exists for it and how many policy versions it has.',
  returns:
    'name, description, status, and counts of AI ratings, confirmed judgements, confirmed positives, policy versions.',
  notes: [
    'Confirmed counts exclude retired judgements (`excluded_reason is not null`).',
    'A label with zero confirmed positives cannot have its recall measured — evaluations there report n/a, not 0.',
  ],
};

export const GET: RequestHandler = async (event) => {
  requireXguardToken(event.request);

  const [labels, rated, confirmed, versions] = await Promise.all([
    labDb
      .selectFrom('label_def')
      .select(['name', 'description', 'status'])
      .orderBy('name')
      .execute(),
    labDb
      .selectFrom('machine_judgement')
      .select(({ fn }) => ['label', fn.countAll<string>().as('n')])
      .where('source', '=', 'ai')
      .groupBy('label')
      .execute(),
    labDb
      .selectFrom('human_judgement')
      .select(({ fn }) => [
        'label',
        fn.count<string>('sample_id').distinct().as('confirmed'),
        fn.count<string>('sample_id').distinct().filterWhere('verdict', '=', true).as('positives'),
      ])
      .where('excluded_reason', 'is', null)
      .groupBy('label')
      .execute(),
    labDb
      .selectFrom('label_policy')
      .select(({ fn }) => [
        'label',
        fn.max<number>('version').as('latest'),
        fn.countAll<string>().as('n'),
      ])
      .groupBy('label')
      .execute(),
  ]);

  return ok({
    labels: labels.map((l) => {
      const truth = confirmed.find((c) => c.label === l.name);
      const policy = versions.find((v) => v.label === l.name);
      return {
        ...l,
        aiRated: Number(rated.find((r) => r.label === l.name)?.n ?? 0),
        confirmed: Number(truth?.confirmed ?? 0),
        confirmedPositives: Number(truth?.positives ?? 0),
        policyVersions: Number(policy?.n ?? 0),
        latestPolicyVersion: policy?.latest ?? null,
      };
    }),
  });
};
