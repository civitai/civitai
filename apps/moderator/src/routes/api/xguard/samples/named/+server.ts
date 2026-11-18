import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineWebhookEndpoint } from '$lib/server/api-endpoint';
import { getLabDb } from '$lib/server/xguard-lab';
import { clickhouseEnv } from '$lib/server/xguard-api';
import {
  DAY_PATTERN,
  importNamedSamples,
  INT64_PATTERN,
  MAX_NAMED_SAMPLES,
  MAX_REFUSED_DAYS,
  NamedSampleInputError,
  REFUSED_PROMPT_HASH_SQL,
} from '$lib/server/xguard-named-samples';
import { clickhouse } from '../../../../../../xguard-lab/sample-core';

const hash = z.string().regex(INT64_PATTERN);

export const POST = defineWebhookEndpoint({
  summary: 'Load a named set of prompts into a batch, by hash, instead of a fresh stratified pull.',
  input: z.object({
    batch: z.string().trim().min(1).max(120).describe('Batch to load into.'),
    generated: z
      .array(hash)
      .max(MAX_NAMED_SAMPLES)
      .optional()
      .describe('promptHash values from orchestration.xguardPromptResults.'),
    refused: z
      .array(z.object({ hash, date: z.string().regex(DAY_PATTERN) }))
      .max(MAX_NAMED_SAMPLES)
      .optional()
      .describe(
        `Refused prompts: ${REFUSED_PROMPT_HASH_SQL} over default.prohibitedRequests, and the createdDate.`
      ),
    blind: z
      .object({ seed: z.number().int().safe() })
      .optional()
      .describe(
        'Store no scores, owner, date or origin, in a seeded shuffled order, for a blind review.'
      ),
  }),
  returns: 'Counts inserted and already present, and every hash that was not found.',
  notes: [
    `At most ${MAX_NAMED_SAMPLES} hashes and ${MAX_REFUSED_DAYS} distinct days per call.`,
    'Idempotent per (batch, hash). Prompt text is read server-side, so the caller sends hashes only.',
    'A batch is either blind or not; mixing the two is refused.',
  ],
  handler: async (input) => {
    const { host, username, password } = clickhouseEnv();
    if (!host) throw new Error('CLICKHOUSE_HOST not set');
    // Read-only and time-boxed: this path builds SQL from caller input.
    const url = new URL(host);
    url.searchParams.set('readonly', '2');
    url.searchParams.set('max_execution_time', '30');
    const config = { host: url.toString(), username, password };
    try {
      const summary = await importNamedSamples(input, {
        query: (sql) => clickhouse(sql, config),
        db: getLabDb(),
      });
      return json(summary, { status: 201 });
    } catch (e) {
      if (e instanceof NamedSampleInputError) error(400, e.message);
      throw e;
    }
  },
});
