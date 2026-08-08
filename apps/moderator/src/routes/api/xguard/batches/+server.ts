import { sql } from '@civitai/db/kysely';
import { defineWebhookEndpoint } from '$lib/server/api-endpoint';
import { getLabDb } from '$lib/server/xguard-lab';

export const GET = defineWebhookEndpoint({
  summary: 'Sampling batches with rating and review coverage per label.',
  returns:
    'One row per (batch, label) with sample count, AI ratings, confirmed judgements — plus the batches nothing has rated yet.',
  notes: [
    'A batch with samples but no ratings is the normal starting state: sample, then rate, then review.',
  ],
  handler: async () => {

    const [batches, coverage] = await Promise.all([
      getLabDb()
        .selectFrom('sample')
        .select(({ fn }) => [
          'batch',
          fn.countAll<string>().as('samples'),
          fn.min<Date>('created_at').as('firstSampledAt'),
          fn.max<Date>('created_at').as('lastSampledAt'),
        ])
        .groupBy('batch')
        .orderBy('batch', 'desc')
        .execute(),
      // One pass over both judgement tables per (batch, label) — a join between them would multiply rows
      // whenever a sample has several reviewers.
      getLabDb()
        .selectFrom('sample as s')
        .innerJoin('machine_judgement as m', 'm.sample_id', 's.id')
        .select(({ fn }) => [
          's.batch',
          'm.label',
          fn.count<string>('m.sample_id').distinct().as('rated'),
          fn
            .count<string>('m.sample_id')
            .distinct()
            .filterWhere('m.verdict', '=', true)
            .as('ratedPositive'),
          sql<string>`count(distinct case when exists (
            select 1 from human_judgement h
             where h.sample_id = s.id and h.label = m.label and h.excluded_reason is null
          ) then s.id end)`.as('confirmed'),
        ])
        .where('m.source', '=', 'ai')
        .groupBy(['s.batch', 'm.label'])
        .execute(),
    ]);

    return {
      batches: batches.map((b) => ({
        batch: b.batch,
        samples: Number(b.samples),
        firstSampledAt: b.firstSampledAt,
        lastSampledAt: b.lastSampledAt,
        labels: coverage
          .filter((c) => c.batch === b.batch)
          .map((c) => ({
            label: c.label,
            rated: Number(c.rated),
            ratedPositive: Number(c.ratedPositive),
            confirmed: Number(c.confirmed),
          })),
      })),
    };
  },
});
