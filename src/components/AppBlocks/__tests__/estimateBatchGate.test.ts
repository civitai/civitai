import { describe, expect, it, vi } from 'vitest';

import {
  ESTIMATE_BATCH_MALFORMED_REPLY,
  estimateBatchReplyFromResult,
  handleEstimateBatch,
} from '../estimateBatchGate';
import { resolveEstimateBatchRequest } from '../pageBlockHostLogic';
import { buildBridgeNackReply } from '../bridgeNackReply';
import { BRIDGE_NACK_NO_HANDLER, nackReplyTypeFor } from '../bridgeTelemetry';
import { INVENTORY } from '../hostHandlerParity';
import { BLOCK_ESTIMATE_BATCH_MAX_CELLS } from '~/shared/constants/block-estimate-batch.constants';
import { blockEstimateBatchInputSchema } from '~/server/schema/blocks/workflow.schema';

/**
 * The `ESTIMATE_WORKFLOW_BATCH` host bridge: the request parser
 * (`resolveEstimateBatchRequest`) and the decide-call-reply layer both hosts share
 * (`handleEstimateBatch`).
 *
 * Cell prices in the fixtures are pairwise distinct (12, 31, 7) and the totals are
 * literals, so a reply that reordered, dropped or repeated a cell is visible.
 */

const body = (prompt: string) => ({
  kind: 'textToImage',
  modelId: 7,
  modelVersionId: 99,
  params: { prompt },
});
const priced = (total: number) => ({
  workflowId: 'wf_estimate',
  status: 'pending',
  cost: { total },
});
const failed = (error: string) => ({ workflowId: 'failed', status: 'failed', error });

type Sent = { type: string; payload: Record<string, unknown> };

async function run(opts: {
  raw: unknown;
  refusal?: string | null;
  token?: string | null;
  estimateBatch?: (input: { blockToken: string; bodies: unknown[] }) => Promise<unknown>;
}) {
  const sent: Sent[] = [];
  const noToken: string[] = [];
  const estimateBatch = vi.fn(
    opts.estimateBatch ??
      (async () => ({ snapshots: [], aggregate: { total: 0, pricedCells: 0, cellCount: 0 } }))
  );
  await handleEstimateBatch({
    raw: opts.raw,
    refusal: opts.refusal ?? null,
    token: opts.token === undefined ? 'tok_page' : opts.token,
    estimateBatch: estimateBatch as never,
    send: (type, payload) => sent.push({ type, payload }),
    onNoToken: (requestId) => noToken.push(requestId),
  });
  return { sent, noToken, estimateBatch };
}

describe('resolveEstimateBatchRequest — the ESTIMATE_WORKFLOW_BATCH parser', () => {
  it('DROPS a payload with no string requestId — there is nothing to reply to', () => {
    expect(resolveEstimateBatchRequest(undefined)).toEqual({ kind: 'drop' });
    expect(resolveEstimateBatchRequest(null)).toEqual({ kind: 'drop' });
    expect(resolveEstimateBatchRequest('nope')).toEqual({ kind: 'drop' });
    expect(resolveEstimateBatchRequest({ bodies: [body('a')] })).toEqual({ kind: 'drop' });
    expect(resolveEstimateBatchRequest({ requestId: 7, bodies: [body('a')] })).toEqual({
      kind: 'drop',
    });
  });

  it('REFUSES a list that is missing, not an array, or empty', () => {
    for (const bodies of [undefined, null, 'x', { 0: body('a') }, []]) {
      expect(resolveEstimateBatchRequest({ requestId: 'r1', bodies })).toEqual({
        kind: 'refuse',
        requestId: 'r1',
        error: 'invalid estimate batch',
      });
    }
  });

  it('accepts 16 bodies and refuses 17', () => {
    const sixteen = Array.from({ length: 16 }, (_, i) => body(`c${i}`));
    expect(resolveEstimateBatchRequest({ requestId: 'r1', bodies: sixteen })).toEqual({
      kind: 'proceed',
      request: { requestId: 'r1', bodies: sixteen },
    });
    expect(
      resolveEstimateBatchRequest({ requestId: 'r1', bodies: [...sixteen, body('c16')] })
    ).toEqual({ kind: 'refuse', requestId: 'r1', error: 'estimate batch too large' });
  });

  it('the parser and the server refuse at the SAME length — one shared constant', () => {
    // 🔴 A RELATIONSHIP, checked at the boundary on both sides. A parser that allowed
    // more than the server would turn every over-long list into a whole-call server
    // error; one that allowed fewer would silently narrow the feature.
    expect(BLOCK_ESTIMATE_BATCH_MAX_CELLS).toBe(16);
    for (const length of [1, 16, 17, 40]) {
      const bodies = Array.from({ length }, (_, i) => body(`c${i}`));
      const parser = resolveEstimateBatchRequest({ requestId: 'r1', bodies }).kind === 'proceed';
      const server = blockEstimateBatchInputSchema.safeParse({ blockToken: 't', bodies }).success;
      expect({ length, parser }).toEqual({ length, parser: server });
    }
  });

  it('passes each body through UNTOUCHED — cells are validated server-side, per cell', () => {
    const bodies = [body('a'), null, { kind: 'nonsense' }, 'text'];
    const decision = resolveEstimateBatchRequest({ requestId: 'r1', bodies });
    expect(decision).toEqual({ kind: 'proceed', request: { requestId: 'r1', bodies } });
  });
});

describe('handleEstimateBatch — decide, call, reply once', () => {
  it('forwards the token and the bodies, and replies with snapshots IN ORDER and the aggregate', async () => {
    const bodies = [body('a'), body('b'), body('c')];
    const { sent, estimateBatch } = await run({
      raw: { requestId: 'r1', bodies },
      estimateBatch: async () => ({
        snapshots: [priced(12), priced(31), priced(7)],
        aggregate: { total: 50, pricedCells: 3, cellCount: 3 },
      }),
    });
    expect(estimateBatch).toHaveBeenCalledTimes(1);
    expect(estimateBatch).toHaveBeenCalledWith({ blockToken: 'tok_page', bodies });
    expect(sent).toEqual([
      {
        type: 'ESTIMATE_BATCH_RESULT',
        payload: {
          requestId: 'r1',
          snapshots: [priced(12), priced(31), priced(7)],
          aggregate: { total: 50, pricedCells: 3, cellCount: 3 },
        },
      },
    ]);
  });

  it('a per-cell failure is a SUCCESSFUL reply — the failed cell rides beside the priced ones', async () => {
    const { sent } = await run({
      raw: { requestId: 'r1', bodies: [body('a'), body('b')] },
      estimateBatch: async () => ({
        snapshots: [failed('modelId mismatch with token'), priced(31)],
        aggregate: { total: 31, pricedCells: 1, cellCount: 2 },
      }),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.error).toBeUndefined();
    expect(sent[0].payload.snapshots).toEqual([failed('modelId mismatch with token'), priced(31)]);
    expect(sent[0].payload.aggregate).toEqual({ total: 31, pricedCells: 1, cellCount: 2 });
  });

  it('passes a cell cost object through verbatim, including fields this host does not know', async () => {
    const future = {
      workflowId: 'wf_estimate',
      status: 'pending',
      cost: { total: 12, somethingAddedLater: { amount: 2 } },
    };
    const { sent } = await run({
      raw: { requestId: 'r1', bodies: [body('a')] },
      estimateBatch: async () => ({
        snapshots: [future],
        aggregate: { total: 12, pricedCells: 1, cellCount: 1 },
      }),
    });
    expect(sent[0].payload.snapshots).toEqual([future]);
  });

  it('a WHOLE-CALL failure (the mutation throws) replies with `error` and no snapshots', async () => {
    const { sent } = await run({
      raw: { requestId: 'r1', bodies: [body('a')] },
      estimateBatch: async () => {
        throw new Error('Rate limit exceeded, please retry shortly.');
      },
    });
    expect(sent).toEqual([
      {
        type: 'ESTIMATE_BATCH_RESULT',
        payload: { requestId: 'r1', error: 'Rate limit exceeded, please retry shortly.' },
      },
    ]);
  });

  it('refuses a malformed list WITHOUT calling the server', async () => {
    const { sent, estimateBatch } = await run({ raw: { requestId: 'r1', bodies: [] } });
    expect(estimateBatch).not.toHaveBeenCalled();
    expect(sent).toEqual([
      {
        type: 'ESTIMATE_BATCH_RESULT',
        payload: { requestId: 'r1', error: 'invalid estimate batch' },
      },
    ]);
  });

  it('a host refusal (review preview) answers before the server is called', async () => {
    const { sent, estimateBatch } = await run({
      raw: { requestId: 'r1', bodies: [body('a')] },
      refusal: 'not available in review preview',
    });
    expect(estimateBatch).not.toHaveBeenCalled();
    expect(sent).toEqual([
      {
        type: 'ESTIMATE_BATCH_RESULT',
        payload: { requestId: 'r1', error: 'not available in review preview' },
      },
    ]);
  });

  it('with no block credential it hands the request to the host and neither calls nor replies', async () => {
    const { sent, noToken, estimateBatch } = await run({
      raw: { requestId: 'r1', bodies: [body('a')] },
      token: null,
    });
    expect(estimateBatch).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(noToken).toEqual(['r1']);
  });

  it('never replies to a payload with no requestId', async () => {
    const { sent, estimateBatch } = await run({ raw: { bodies: [body('a')] } });
    expect(estimateBatch).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('a result that does not answer the request is reported as an error, not forwarded', async () => {
    for (const result of [
      // One snapshot for two bodies.
      { snapshots: [priced(12)], aggregate: { total: 12, pricedCells: 1, cellCount: 1 } },
      // A cell with an empty workflowId — the SDK would drop the whole reply.
      {
        snapshots: [priced(12), { workflowId: '', status: 'pending' }],
        aggregate: { total: 12, pricedCells: 1, cellCount: 2 },
      },
      // No aggregate.
      { snapshots: [priced(12), priced(31)] },
      null,
    ]) {
      const { sent } = await run({
        raw: { requestId: 'r1', bodies: [body('a'), body('b')] },
        estimateBatch: async () => result,
      });
      expect(sent).toEqual([
        {
          type: 'ESTIMATE_BATCH_RESULT',
          payload: { requestId: 'r1', error: ESTIMATE_BATCH_MALFORMED_REPLY },
        },
      ]);
    }
  });
});

describe('estimateBatchReplyFromResult', () => {
  it('copies the aggregate BY NAME — an extra field the procedure grows does not reach the block', () => {
    const reply = estimateBatchReplyFromResult(
      {
        snapshots: [priced(12)],
        aggregate: { total: 12, pricedCells: 1, cellCount: 1, internal: 'x' },
      } as never,
      1
    );
    expect(reply).toEqual({
      snapshots: [priced(12)],
      aggregate: { total: 12, pricedCells: 1, cellCount: 1 },
    });
  });
});

describe('ESTIMATE_WORKFLOW_BATCH in the bridge inventory', () => {
  it('is a REQUEST both live hosts must handle, answered on ESTIMATE_BATCH_RESULT', () => {
    expect(INVENTORY.ESTIMATE_WORKFLOW_BATCH).toMatchObject({
      request: true,
      reply: 'ESTIMATE_BATCH_RESULT',
      IframeHost: 'required',
      PageBlockHost: 'required',
    });
  });

  it('a host with no handler NACKs it with a bare `{ requestId, error }`, not a snapshot', () => {
    // The reply is in the `{ error }` family: the SDK hook reads `error` and turns
    // `unsupported on this host` into its typed "fall back to per-cell" error.
    expect(nackReplyTypeFor('ESTIMATE_WORKFLOW_BATCH')).toBe('ESTIMATE_BATCH_RESULT');
    expect(buildBridgeNackReply('ESTIMATE_WORKFLOW_BATCH', 'r1', BRIDGE_NACK_NO_HANDLER)).toEqual({
      type: 'ESTIMATE_BATCH_RESULT',
      payload: { requestId: 'r1', error: 'unsupported on this host' },
    });
  });
});
