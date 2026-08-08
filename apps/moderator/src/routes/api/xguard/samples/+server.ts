import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineWebhookEndpoint } from '$lib/server/api-endpoint';
import { labDb } from '$lib/server/xguard-lab';
import { clickhouseEnv, idOf, labConnectionString } from '$lib/server/xguard-api';
import { sampleBatch } from '../../../../../xguard-lab/sample-core';

// Clamped rather than rejected, so a caller looping with a too-large page size still makes progress.
const bounded = (fallback: number, min: number, max: number) =>
  z.coerce
    .number()
    .int()
    .default(fallback)
    .transform((n) => Math.min(max, Math.max(min, n)));

export const GET = defineWebhookEndpoint({
  summary: 'List sampled prompts with their AI rating and review state.',
  input: z.object({
    batch: z.string().trim().min(1).optional().describe('Restrict to one sampling batch.'),
    label: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Which label's rating and review state to report. Required by the two filters below."),
    reviewed: z
      .enum(['yes', 'no'])
      .optional()
      .describe('Only samples a human has (or has not) confirmed for that label.'),
    aiVerdict: z
      .enum(['true', 'false'])
      .optional()
      .describe('Only samples the AI rater judged that way.'),
    limit: bounded(50, 1, 500).describe('Samples to return, 1-500.'),
    offset: bounded(0, 0, Number.MAX_SAFE_INTEGER).describe('Rows to skip.'),
  }),
  returns: 'Samples with prompt text, live scores, AI verdict and confirmed verdict.',
  notes: [
    'Everything sampled so far comes from prompts XGuard already flagged, so absolute recall is not measurable from it.',
  ],
  handler: async ({ batch, label, reviewed, aiVerdict, limit, offset }) => {
    let query = labDb
      .selectFrom('sample as s')
      .select([
        's.id',
        's.batch',
        's.source',
        's.user_id as userId',
        's.positive_prompt as positivePrompt',
        's.negative_prompt as negativePrompt',
        's.live_scores as liveScores',
        's.prompt_created_at as promptCreatedAt',
      ])
      .orderBy('s.id')
      .limit(limit)
      .offset(offset);

    if (batch) query = query.where('s.batch', '=', batch);

    // Filters are `exists` subqueries rather than a join: the rating is fetched separately below, and a
    // join against a table with one row per (sample, label, source) would need care not to multiply rows.
    if (label && aiVerdict) {
      query = query.where(({ exists, selectFrom }) =>
        exists(
          selectFrom('machine_judgement as m')
            .select('m.id')
            .whereRef('m.sample_id', '=', 's.id')
            .where('m.label', '=', label)
            .where('m.source', '=', 'ai')
            .where('m.verdict', '=', aiVerdict === 'true')
        )
      );
    }
    if (label && reviewed) {
      query = query.where(({ exists, not, selectFrom }) => {
        const has = exists(
          selectFrom('human_judgement as h')
            .select('h.id')
            .whereRef('h.sample_id', '=', 's.id')
            .where('h.label', '=', label)
            .where('h.excluded_reason', 'is', null)
        );
        return reviewed === 'yes' ? has : not(has);
      });
    }

    const rows = await query.execute();

    const ratings =
      label && rows.length
        ? await labDb
            .selectFrom('machine_judgement')
            .select(['sample_id as sampleId', 'verdict', 'reason', 'model'])
            .where('label', '=', label)
            .where('source', '=', 'ai')
            .where(
              'sample_id',
              'in',
              rows.map((r) => r.id)
            )
            .execute()
        : [];

    return {
      label: label ?? null,
      batch: batch ?? null,
      limit,
      offset,
      samples: rows.map((r) => {
        const id = idOf(r.id);
        const rating = label ? ratings.find((m) => idOf(m.sampleId) === id) : undefined;
        return {
          ...r,
          id,
          aiVerdict: rating?.verdict ?? null,
          aiReason: rating?.reason ?? null,
          aiModel: rating?.model ?? null,
        };
      }),
    };
  },
});

export const POST = defineWebhookEndpoint({
  summary: 'Pull a fresh stratified batch of prompts from live traffic.',
  input: z.object({
    batch: z.string().trim().min(1).max(120).describe('Name for this sampling batch.'),
    label: z.string().trim().min(1).optional().describe('Stratify against this label’s live scores.'),
    size: bounded(500, 1, 5000).describe('Prompts to pull, 1-5000.'),
    bands: bounded(5, 1, 20).describe('Score bands to stratify across, 1-20.'),
    days: bounded(7, 1, 365).describe('How far back to sample, 1-365 days.'),
  }),
  returns: 'Per-band counts and how many rows were inserted.',
  notes: [
    'Idempotent per (batch, prompt hash) — re-running a batch tops it up rather than duplicating it.',
  ],
  handler: async ({ batch, label, size, bands, days }) => {
    const summary = await sampleBatch({
      connectionString: labConnectionString(),
      batch,
      label,
      size,
      bands,
      days,
      clickhouse: clickhouseEnv(),
    });
    return json(summary, { status: 201 });
  },
});
