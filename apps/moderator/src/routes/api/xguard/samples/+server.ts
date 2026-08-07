import type { RequestHandler } from './$types';
import { requireApiAccess, ok, readJson, intParam, type EndpointDoc } from '$lib/server/api-guard';
import { labDb } from '$lib/server/xguard-lab';
import { clickhouseEnv, idOf, labConnectionString, requireName } from '$lib/server/xguard-api';
import { sampleBatch } from '../../../../../xguard-lab/sample-core';

export const _doc: EndpointDoc = {
  summary:
    'List sampled prompts with their AI rating and review state, or pull a fresh stratified batch from live traffic.',
  params: [
    { name: 'batch', type: 'string', description: 'Restrict to one sampling batch.' },
    {
      name: 'label',
      type: 'string',
      description:
        "Which label's rating and review state to report. Required for reviewed/aiVerdict filters.",
    },
    {
      name: 'reviewed',
      type: '"yes" | "no"',
      description: 'Only samples a human has (or has not) confirmed for that label.',
    },
    {
      name: 'aiVerdict',
      type: '"true" | "false"',
      description: 'Only samples the AI rater judged that way.',
    },
    { name: 'limit', type: 'number', description: 'Default 50, max 500.' },
    { name: 'offset', type: 'number', description: 'Default 0.' },
    {
      name: 'size',
      type: 'number (POST body)',
      description: 'Prompts to pull. Default 500, max 5000.',
    },
    { name: 'days', type: 'number (POST body)', description: 'How far back to sample. Default 7.' },
    {
      name: 'bands',
      type: 'number (POST body)',
      description: 'Score bands to stratify across. Default 5.',
    },
  ],
  returns:
    'GET: samples with prompt text, live scores, AI verdict, confirmed verdict. POST: per-band counts and how many rows were inserted.',
  notes: [
    'POST is idempotent per (batch, prompt hash) — re-running a batch tops it up rather than duplicating it.',
    'Everything sampled so far comes from prompts XGuard already flagged, so absolute recall is not measurable from it.',
  ],
};

export const GET: RequestHandler = async (event) => {
  requireApiAccess(event, '/xguard');
  const url = event.url;
  const batch = url.searchParams.get('batch');
  const label = url.searchParams.get('label');
  const reviewed = url.searchParams.get('reviewed');
  const aiVerdict = url.searchParams.get('aiVerdict');
  const limit = intParam(url, 'limit', 50, 1, 500);
  const offset = intParam(url, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);

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
  if (label && (aiVerdict === 'true' || aiVerdict === 'false')) {
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
  if (label && (reviewed === 'yes' || reviewed === 'no')) {
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

  return ok({
    label,
    batch,
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
  });
};

export const POST: RequestHandler = async (event) => {
  requireApiAccess(event, '/xguard');
  const body = await readJson<Record<string, unknown>>(event);
  const clickhouse = clickhouseEnv();

  const summary = await sampleBatch({
    connectionString: labConnectionString(),
    batch: requireName(body.batch, 'batch'),
    label: typeof body.label === 'string' ? body.label : undefined,
    size: clamp(body.size, 500, 1, 5000),
    bands: clamp(body.bands, 5, 1, 20),
    days: clamp(body.days, 7, 1, 365),
    clickhouse,
  });

  return ok(summary, 201);
};

function clamp(raw: unknown, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
