import { Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';

/** The Training Studio's call into the training text rule (real rule, classifier mocked): how its
 *  verdicts reach the Studio. */

const classifyPromptExternally = vi.hoisted(() =>
  vi.fn(async (_prompt: string, _source?: string) => ({
    categories: [] as string[],
    externalError: null,
  }))
);
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({ classifyPromptExternally }));
const gate = vi.hoisted(() => ({ allow: vi.fn(), rate: vi.fn() }));
vi.mock('~/server/utils/training-studio-access', () => ({ allowTrainingStudio: gate.allow }));
vi.mock('~/server/utils/block-catalog-rate-limit', () => ({ checkFixedWindow: gate.rate }));
// The auth wrapper is the shared one; here it only supplies the caller. Errors go through the real
// handler, so the response bodies are the ones the Studio receives.
vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  handleEndpointError: (await importOriginal<typeof EndpointHelpers>()).handleEndpointError,
  AuthedEndpoint:
    (handler: (req: unknown, res: unknown, user: { id: number }) => unknown) =>
    (req: unknown, res: unknown) =>
      handler(req, res, { id: 7 }),
}));

import handler from '~/pages/api/training-studio/check-text';

async function call(body: unknown) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const req = Object.assign(Readable.from([Buffer.from(raw)]), { method: 'POST' });
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
  await (handler as unknown as (req: unknown, r: typeof res) => Promise<unknown>)(req, res);
  return res;
}

describe('POST /api/training-studio/check-text', () => {
  beforeEach(() => {
    classifyPromptExternally.mockClear();
    gate.allow.mockReset().mockResolvedValue(true);
    gate.rate.mockReset().mockResolvedValue({ allowed: true });
  });

  it('answers ok for clean text, having run the classifier over it', async () => {
    const res = await call({ triggerWord: 'mystyle', captions: ['a cat on a sofa'] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(classifyPromptExternally).toHaveBeenCalledWith(
      expect.stringContaining('a cat on a sofa'),
      expect.anything()
    );
  });

  it('passes a refusal on as a 400 with its reason', async () => {
    const res = await call({ triggerWord: '8 year old girl', captions: [] });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: expect.stringContaining('have been blocked') });
  });

  it('answers a body past the cap as too large, without parsing or checking it', async () => {
    const res = await call({ triggerWord: 'x', captions: ['a'.repeat(6 * 1024 * 1024)] });
    expect(res.statusCode).toBe(413);
    expect(gate.rate).not.toHaveBeenCalled();
    expect(classifyPromptExternally).not.toHaveBeenCalled();
  });

  it('refuses more text than one check covers, before the classifier', async () => {
    const res = await call({ triggerWord: 'x', captions: Array(300).fill('a, '.repeat(5000)) });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: expect.stringContaining('more text than can be checked') });
    expect(classifyPromptExternally).not.toHaveBeenCalled();
  });

  it('applies the account gates but not the embed page flag', async () => {
    await call({ triggerWord: 'mystyle', captions: ['a cat'] });
    expect(gate.allow).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      {
        pageFlag: false,
      }
    );
  });

  it('runs nothing for a caller the Studio gates refuse', async () => {
    gate.allow.mockResolvedValue(false);
    await call({ triggerWord: 'mystyle', captions: ['a cat'] });
    expect(gate.rate).not.toHaveBeenCalled();
    expect(classifyPromptExternally).not.toHaveBeenCalled();
  });

  it('charges the caller one unit per classifier batch, keyed by user', async () => {
    await call({ triggerWord: 'mystyle', captions: Array(3).fill('b'.repeat(15_000)) });
    const [key, , , weight] = gate.rate.mock.calls[0] as [string, number, number, number];
    expect(key).toMatch(/:7$/);
    expect(weight).toBe(3);
  });

  it('refuses over the rate limit with a Retry-After, without running the classifier', async () => {
    gate.rate.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    const res = await call({ triggerWord: 'mystyle', captions: ['a cat'] });
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('30');
    expect(classifyPromptExternally).not.toHaveBeenCalled();
  });

  it.each([
    ['a body that is not JSON', 'not json'],
    ['the wrong shape', { triggerWord: 1, captions: 'x' }],
  ])('answers %s as invalid, without running the rule', async (_l, body) => {
    const res = await call(body);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid training text.' });
    expect(classifyPromptExternally).not.toHaveBeenCalled();
  });

  it('answers an unexpected failure as a generic server error, never as ok', async () => {
    classifyPromptExternally.mockRejectedValueOnce(new Error('boom'));
    const res = await call({ triggerWord: 'mystyle', captions: ['a cat'] });
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('boom');
  });
});
