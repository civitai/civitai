import type { NextApiResponse } from 'next';
import type { AxiomAPIRequest } from '@civitai/next-axiom';
import * as z from 'zod';
import { logToAxiom, safeError } from '~/server/logging/client';
import { recordAssistantTurn } from '~/server/services/app-assistant/session-tracing.service';
import { readRunnerRequest, runnerAppKey } from '~/server/services/app-assistant/runner-request';

/** The most distinct tools one report may name: far above App Assistant's own tool count. */
const MAX_TOOLS = 200;

export const runnerTurnBody = z.object({
  v: z.literal(1),
  grant: z.string().min(1).max(4096),
  app: runnerAppKey.nullable(),
  seq: z.number().int().min(0).max(1_000_000),
  runId: z.string().min(1).max(200),
  model: z.string().min(1).max(200),
  status: z.enum(['done', 'error', 'stopped', 'ran_out']),
  buzz: z.number().finite().min(0).max(1e9),
  toolCalls: z
    .record(z.string().min(1).max(200), z.number().int().min(0).max(100_000))
    .refine((counts) => Object.keys(counts).length <= MAX_TOOLS, 'too many tools'),
  durationMs: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 60 * 60 * 1000),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
});

/**
 * The handler of `/api/internal/app-assistant/turn`: App Assistant's server runner reports each
 * finished turn, for the user and the chat its run grant names, and civitai records it for session
 * tracing (`recordAssistantTurn`: the chat ↔ app link row and one ClickHouse row), or does nothing
 * while the `app-assistant-tracing` flag is off. See the route's header for the contract.
 *
 * The user and the conversation come from the VERIFIED grant, never from the body. The app key is
 * the chat's own claim (what its `create_app` / `use_open_app` calls answered), recorded as such:
 * no ownership check is made here, and readers only trust a link whose user is the submitter.
 */
export async function runnerTurnRoute(req: AxiomAPIRequest, res: NextApiResponse) {
  const request = await readRunnerRequest(req, res, runnerTurnBody, 'Expected a turn report');
  if (!request) return;
  const { grant, body } = request;
  // A preview grant opens one live preview and runs no reply: it has no turn to report.
  if (grant.use === 'preview')
    return res.status(403).json({ error: 'A preview grant reports no turns', code: 'refused' });

  try {
    const outcome = await recordAssistantTurn({
      userId: grant.userId,
      conversationId: grant.conversationId,
      appSlug: body.app,
      seq: body.seq,
      runId: body.runId,
      model: body.model,
      status: body.status,
      buzz: body.buzz,
      toolCalls: body.toolCalls,
      durationMs: body.durationMs,
      startedAt: new Date(body.startedAt),
      endedAt: new Date(body.endedAt),
    });
    return res.json(outcome);
  } catch (err) {
    // `recordAssistantTurn` never throws; this is the last line, so a report never 500s.
    logToAxiom({
      type: 'app-assistant.runner-turn.failed',
      message: `App Assistant runner turn report failed for user ${grant.userId}`,
      userId: grant.userId,
      error: safeError(err),
    });
    return res.status(503).json({ error: 'Could not record the turn', code: 'unavailable' });
  }
}
