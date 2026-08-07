import type { PageServerLoad } from './$types';
import { requireAccess } from '$lib/server/access';
import { labDb } from '$lib/server/xguard-lab';

// Per-label state of the lab: how much data exists, how much of it is confirmed, and what the last
// evaluation said.
//
// The number that matters most is `positives` - confirmed ground truth where the answer is yes. A
// label with 200 confirmed negatives and no positives cannot have its recall measured at all, and
// nothing else on the page makes that obvious.

export const load: PageServerLoad = async ({ locals, url }) => {
  requireAccess(locals.user, url.pathname);

  const labels = await labDb
    .selectFrom('label_def as l')
    .select((eb) => [
      'l.name',
      'l.description',
      'l.status',
      eb
        .selectFrom('machine_judgement as m')
        .select(({ fn }) => fn.countAll<string>().as('c'))
        .whereRef('m.label', '=', 'l.name')
        .where('m.source', '=', 'ai')
        .as('rated'),
      eb
        .selectFrom('machine_judgement as m')
        .select(({ fn }) => fn.countAll<string>().as('c'))
        .whereRef('m.label', '=', 'l.name')
        .where('m.source', '=', 'ai')
        .where('m.verdict', '=', true)
        .as('ratedPositive'),
      eb
        .selectFrom('human_judgement as h')
        .select(({ fn }) => fn.count<string>('h.sample_id').distinct().as('c'))
        .whereRef('h.label', '=', 'l.name')
        .where('h.excluded_reason', 'is', null)
        .as('confirmed'),
      eb
        .selectFrom('human_judgement as h')
        .select(({ fn }) => fn.count<string>('h.sample_id').distinct().as('c'))
        .whereRef('h.label', '=', 'l.name')
        .where('h.verdict', '=', true)
        .where('h.excluded_reason', 'is', null)
        .as('positives'),
      eb
        .selectFrom('label_policy as p')
        .select(({ fn }) => fn.max<number>('p.version').as('v'))
        .whereRef('p.label', '=', 'l.name')
        .as('policyVersion'),
    ])
    .orderBy('l.name')
    .execute();

  // Latest completed run per label. One query, then matched up in memory - a lateral join for a
  // handful of labels is not worth the SQL.
  const runs = await labDb
    .selectFrom('eval_run')
    .select([
      'id',
      'label',
      'policy_label as policyLabel',
      'threshold',
      'tp',
      'fp',
      'tn',
      'fn',
      'precision',
      'recall',
      'started_at as startedAt',
    ])
    .where('status', '=', 'complete')
    .orderBy('started_at', 'desc')
    .execute();

  const latestRun = new Map<string, (typeof runs)[number]>();
  for (const run of runs) if (!latestRun.has(run.label)) latestRun.set(run.label, run);

  return {
    labels: labels.map((l) => ({
      ...l,
      rated: Number(l.rated ?? 0),
      ratedPositive: Number(l.ratedPositive ?? 0),
      confirmed: Number(l.confirmed ?? 0),
      positives: Number(l.positives ?? 0),
      policyVersion: l.policyVersion ?? null,
      lastRun: latestRun.get(l.name) ?? null,
    })),
  };
};
