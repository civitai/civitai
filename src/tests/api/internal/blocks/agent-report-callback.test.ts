import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Readable } from 'node:stream';

/**
 * AGENTIC MOD CODE-REVIEW (App Blocks P1) — POST
 * /api/internal/blocks/agent-report-callback:
 *   - per-review BEARER auth (not the shared HMAC) — bad/missing → 401
 *   - pipeline kill-switch → 503 (dark posture)
 *   - checkCallbackTimestamp replay window (enforce-if-present)
 *   - report shape validation + status passthrough (cost-capped persisted verbatim)
 *   - UPDATE guarded to status='running' — a torn-down/decided review is a no-op
 */

const { mockFlag, mockVerify, mockUpdateMany, mockTs } = vi.hoisted(() => ({
  mockFlag: { enabled: true },
  mockVerify: vi.fn(
    (): { ok: boolean; publishRequestId?: string } => ({ ok: true, publishRequestId: 'x' })
  ),
  mockUpdateMany: vi.fn(async (_args: { where: unknown; data: any }) => ({ count: 1 })),
  // Faithful ±300s stand-in for the reused checkCallbackTimestamp.
  mockTs: vi.fn((ts: unknown) => {
    if (ts === undefined || ts === null) return { ok: true };
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return { ok: false, reason: 'bad' };
    return Math.abs(Math.floor(Date.now() / 1000) - ts) > 300
      ? { ok: false, reason: 'skew' }
      : { ok: true };
  }),
}));

vi.mock('@civitai/next-axiom', () => ({ withAxiom: (h: unknown) => h }));
vi.mock('~/server/services/app-blocks-flag', () => ({
  isAppBlocksPipelineEnabled: vi.fn(async () => mockFlag.enabled),
}));
vi.mock('~/server/services/blocks/review-session', () => ({
  verifyAgentCallbackToken: mockVerify,
}));
vi.mock('~/pages/api/internal/blocks/review-build-callback', () => ({
  checkCallbackTimestamp: mockTs,
}));
vi.mock('~/server/db/client', () => ({
  dbWrite: { appReviewAgentReport: { updateMany: mockUpdateMany } },
}));

import handler, {
  buildReportUpdate,
  persistedStatusFor,
} from '~/pages/api/internal/blocks/agent-report-callback';

const PUBREQ = 'pubreq_0123456789ABCDEFGHJKMNPQRS';

function makeReqRes(body: string, opts: { method?: string; auth?: string } = {}) {
  const stream = Readable.from([Buffer.from(body)]) as unknown as NextApiRequest;
  stream.method = opts.method ?? 'POST';
  (stream as any).headers = { authorization: opts.auth ?? 'Bearer good.token' };
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader() {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return { req: stream, res: res as unknown as NextApiResponse & { statusCode: number; body: any } };
}

const goodBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    publishRequestId: PUBREQ,
    status: 'complete',
    model: 'anthropic/claude',
    codeReview: { findings: [] },
    securityAudit: { high: 0 },
    scopeVerdicts: { 'apps:storage': 'ok' },
    summaryMd: '# Looks fine',
    tokenUsage: { input: 10, output: 20 },
    costUsd: 0.42,
    ...over,
  });

beforeEach(() => {
  mockFlag.enabled = true;
  mockVerify.mockReturnValue({ ok: true, publishRequestId: PUBREQ });
  mockUpdateMany.mockResolvedValue({ count: 1 });
});
afterEach(() => vi.clearAllMocks());

describe('persistedStatusFor / buildReportUpdate (pure)', () => {
  it('persists every runner status verbatim (cost-capped no longer collapses to failed)', () => {
    expect(persistedStatusFor('complete')).toBe('complete');
    expect(persistedStatusFor('failed')).toBe('failed');
    expect(persistedStatusFor('cost-capped')).toBe('cost-capped');
  });

  it('writes the provided structured fields + costUsd', () => {
    const data = buildReportUpdate(JSON.parse(goodBody()));
    expect(data).toMatchObject({
      status: 'complete',
      model: 'anthropic/claude',
      codeReview: { findings: [] },
      securityAudit: { high: 0 },
      scopeVerdicts: { 'apps:storage': 'ok' },
      tokenUsage: { input: 10, output: 20 },
      costUsd: 0.42,
    });
    expect(data.completedAt).toBeInstanceOf(Date);
  });

  it('persists cost-capped verbatim AND prepends a cost-cap marker to the summary', () => {
    const data = buildReportUpdate(JSON.parse(goodBody({ status: 'cost-capped' })));
    expect(data.status).toBe('cost-capped');
    expect(String(data.summaryMd)).toContain('cost cap');
  });

  it('drops a non-finite / negative costUsd', () => {
    expect(buildReportUpdate(JSON.parse(goodBody({ costUsd: -1 }))).costUsd).toBeUndefined();
    expect(buildReportUpdate(JSON.parse(goodBody({ costUsd: 'nope' }))).costUsd).toBeUndefined();
  });
});

describe('POST /api/internal/blocks/agent-report-callback', () => {
  it('405 on non-POST', async () => {
    const { req, res } = makeReqRes(goodBody(), { method: 'GET' });
    await handler(req, res);
    expect(res.statusCode).toBe(405);
  });

  it('400 on invalid JSON', async () => {
    const { req, res } = makeReqRes('{not json');
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('400 on an invalid publishRequestId', async () => {
    const { req, res } = makeReqRes(goodBody({ publishRequestId: 'nope' }));
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('401 on a bad/missing bearer', async () => {
    mockVerify.mockReturnValue({ ok: false });
    const { req, res } = makeReqRes(goodBody(), { auth: 'Bearer wrong' });
    await handler(req, res);
    expect(res.statusCode).toBe(401);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('verifies the bearer is bound to the body publishRequestId', async () => {
    const { req, res } = makeReqRes(goodBody());
    await handler(req, res);
    expect(mockVerify).toHaveBeenCalledWith('good.token', PUBREQ);
  });

  it('503 under the pipeline kill-switch (dark)', async () => {
    mockFlag.enabled = false;
    const { req, res } = makeReqRes(goodBody());
    await handler(req, res);
    expect(res.statusCode).toBe(503);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it('401 on a stale timestamp', async () => {
    const { req, res } = makeReqRes(goodBody({ ts: 1 }));
    await handler(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('400 on an unknown status', async () => {
    const { req, res } = makeReqRes(goodBody({ status: 'weird' }));
    await handler(req, res);
    expect(res.statusCode).toBe(400);
  });

  it('200 applied:true — writes the report to the running row', async () => {
    const { req, res } = makeReqRes(goodBody());
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, applied: true });
    const args = mockUpdateMany.mock.calls[0][0];
    expect(args.where).toEqual({ publishRequestId: PUBREQ, status: 'running' });
    expect(args.data.status).toBe('complete');
  });

  it('200 applied:false when there is no running row (torn down / decided)', async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 });
    const { req, res } = makeReqRes(goodBody());
    await handler(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, applied: false });
  });
});
