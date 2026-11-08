import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AutoLabelService from '~/server/services/training-studio-auto-label.service';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';

/** The standalone Studio's auto-label endpoint: it must run the embed's free path as the session's
 *  user, behind the same gates and per-minute buckets. */

const service = vi.hoisted(() => ({
  submit: vi.fn(async (_input: unknown) => ({ workflowId: 'wf-1' })),
  poll: vi.fn(async (_input: unknown) => ({ done: true, results: [] })),
}));
vi.mock('~/server/services/training-studio-auto-label.service', async (importOriginal) => ({
  STUDIO_AUTO_LABEL_RATE_LIMITS: (await importOriginal<typeof AutoLabelService>())
    .STUDIO_AUTO_LABEL_RATE_LIMITS,
  submitStudioAutoLabel: service.submit,
  pollStudioAutoLabel: service.poll,
}));
const limiter = vi.hoisted(() => ({ claim: vi.fn(), record: vi.fn(async () => undefined) }));
vi.mock('~/server/utils/rate-limit-bucket', () => ({ claimRateLimitAttempt: limiter.claim }));
const gate = vi.hoisted(() => ({ allow: vi.fn() }));
vi.mock('~/server/utils/training-studio-access', () => ({ allowTrainingStudio: gate.allow }));
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  handleEndpointError: (await importOriginal<typeof EndpointHelpers>()).handleEndpointError,
  AuthedEndpoint:
    (handler: (req: unknown, res: unknown, user: { id: number }) => unknown) =>
    (req: unknown, res: unknown) =>
      handler(req, res, { id: 7 }),
}));

import handler from '~/pages/api/training-studio/auto-label';

const mediaUrl = 'https://orchestration.civitai.com/v2/consumer/blobs/a.png';
const submitBody = { mode: 'tag', media: 'image', items: [{ mediaUrl, key: 'a' }] };

async function call(req: { method: string; body?: unknown; query?: unknown }) {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: unknown) {
      this.body = data;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
  };
  await (handler as unknown as (req: unknown, r: typeof res) => Promise<unknown>)(
    { query: {}, ...req },
    res
  );
  return res;
}

describe('/api/training-studio/auto-label', () => {
  beforeEach(() => {
    service.submit.mockClear();
    service.poll.mockClear();
    limiter.claim.mockReset().mockResolvedValue(limiter.record);
    limiter.record.mockClear();
    gate.allow.mockReset().mockResolvedValue(true);
  });

  it("submits as the session's user, never a user named in the body", async () => {
    const res = await call({ method: 'POST', body: { ...submitBody, userId: 99 } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ workflowId: 'wf-1' });
    expect(service.submit).toHaveBeenCalledWith({ ...submitBody, userId: 7 });
  });

  it("polls as the session's user, never a user named in the query", async () => {
    const res = await call({ method: 'GET', query: { workflowId: 'wf-1', userId: '99' } });
    expect(res.statusCode).toBe(200);
    expect(service.poll).toHaveBeenCalledWith({ workflowId: 'wf-1', userId: 7 });
  });

  it("answers another user's workflow as not found", async () => {
    service.poll.mockRejectedValueOnce(
      new TRPCError({ code: 'NOT_FOUND', message: 'Workflow not found' })
    );
    const res = await call({ method: 'GET', query: { workflowId: 'wf-other' } });
    expect(res.statusCode).toBe(404);
  });

  // The embed's procedures key their buckets on these names, so both surfaces share one quota.
  it.each([
    ['submit', { method: 'POST', body: submitBody }, 'training:studioAutoLabelSubmit', 100],
    [
      'poll',
      { method: 'GET', query: { workflowId: 'wf-1' } },
      'training:studioAutoLabelPoll',
      1500,
    ],
  ])("draws a %s from the embed procedure's bucket", async (_l, req, keyName, limit) => {
    await call(req);
    expect(limiter.claim).toHaveBeenCalledWith(
      expect.objectContaining({ keyName, rules: [{ limit, period: 60 }], user: { id: 7 } })
    );
    expect(limiter.record).toHaveBeenCalled();
  });

  it('refuses past the limit with a 429, before any work', async () => {
    limiter.claim.mockRejectedValueOnce(
      new TRPCError({ code: 'TOO_MANY_REQUESTS', message: "You're doing that too much..." })
    );
    const res = await call({ method: 'POST', body: submitBody });
    expect(res.statusCode).toBe(429);
    expect(service.submit).not.toHaveBeenCalled();
  });

  it('applies the account gates but not the embed page flag, and runs nothing past a refusal', async () => {
    gate.allow.mockResolvedValue(false);
    await call({ method: 'POST', body: submitBody });
    expect(gate.allow).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      {
        pageFlag: false,
      }
    );
    expect(service.submit).not.toHaveBeenCalled();
    expect(limiter.claim).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-https media URL', { ...submitBody, items: [{ mediaUrl: 'http://x/a.png', key: 'a' }] }],
    ['audio in tag mode', { ...submitBody, media: 'audio' }],
    ['no items', { ...submitBody, items: [] }],
  ])('answers %s as invalid, without submitting', async (_l, body) => {
    const res = await call({ method: 'POST', body });
    expect(res.statusCode).toBe(400);
    expect(service.submit).not.toHaveBeenCalled();
  });
});
