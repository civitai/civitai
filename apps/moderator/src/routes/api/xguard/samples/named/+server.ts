import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineWebhookEndpoint } from '$lib/server/api-endpoint';
import { getLabDb } from '$lib/server/xguard-lab';
import { clickhouseEnv } from '$lib/server/xguard-api';
import {
  importNamedSamples,
  MAX_NAMED_SAMPLES,
  REFUSED_PROMPT_HASH_SQL,
} from '$lib/server/xguard-named-samples';
import { clickhouse, type ClickHouseConfig } from '../../../../../../xguard-lab/sample-core';

const hash = z.string().regex(/^-?\d{1,20}$/);

export const POST = defineWebhookEndpoint({
  summary: 'Load a named set of prompts into a batch, by hash, instead of a fresh stratified pull.',
  input: z.object({
    batch: z.string().trim().min(1).max(120).describe('Batch to load into.'),
    generated: z
      .array(hash)
      .optional()
      .describe('promptHash values from orchestration.xguardPromptResults.'),
    refused: z
      .array(z.object({ hash, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }))
      .optional()
      .describe(
        `Refused prompts: ${REFUSED_PROMPT_HASH_SQL} over default.prohibitedRequests, and the createdDate.`
      ),
  }),
  returns: 'Counts inserted and already present, and every hash that was not found.',
  notes: [
    `At most ${MAX_NAMED_SAMPLES} hashes per call.`,
    'Idempotent per (batch, hash). Prompt text is read server-side, so the caller sends hashes only.',
  ],
  handler: async (input) => {
    const { host, username, password } = clickhouseEnv();
    if (!host) throw new Error('CLICKHOUSE_HOST not set');
    const config: ClickHouseConfig = { host, username, password };
    const summary = await importNamedSamples(input, {
      query: (sql) => clickhouse(sql, config),
      db: getLabDb(),
    });
    return json(summary, { status: 201 });
  },
});
