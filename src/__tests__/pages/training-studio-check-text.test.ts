import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';

/** The Training Studio's call into the trigger word check (real rule, classifier mocked): how its
 *  verdicts reach the Studio. */

const classifyPromptExternally = vi.hoisted(() =>
  vi.fn(async (_prompt: string, _source?: string) => ({
    categories: [] as string[],
    externalError: null,
  }))
);
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({ classifyPromptExternally }));
const gate = vi.hoisted(() => ({ allow: vi.fn() }));
vi.mock('~/server/utils/training-studio-access', () => ({ allowTrainingStudio: gate.allow }));
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
  const req = { method: 'POST', body };
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
  });

  it('answers ok for a clean trigger word, having run the classifier over it', async () => {
    const res = await call({ triggerWord: 'mystyle' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(classifyPromptExternally).toHaveBeenCalledWith('mystyle', expect.anything());
  });

  it('passes a refusal on as a 400 with its reason', async () => {
    const res = await call({ triggerWord: '8 year old girl' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: expect.stringContaining('has been blocked') });
  });

  it('applies the account gates but not the embed page flag', async () => {
    await call({ triggerWord: 'mystyle' });
    expect(gate.allow).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { pageFlag: false }
    );
  });

  it('runs nothing for a caller the Studio gates refuse', async () => {
    gate.allow.mockResolvedValue(false);
    await call({ triggerWord: 'mystyle' });
    expect(classifyPromptExternally).not.toHaveBeenCalled();
  });

  it.each([
    ['the wrong shape', { triggerWord: 1 }],
    ['an oversized trigger word', { triggerWord: 'a'.repeat(1001) }],
  ])('answers %s as invalid, without running the rule', async (_l, body) => {
    const res = await call(body);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid trigger word.' });
    expect(classifyPromptExternally).not.toHaveBeenCalled();
  });

  it('answers an unexpected failure as a generic server error, never as ok', async () => {
    classifyPromptExternally.mockRejectedValueOnce(new Error('boom'));
    const res = await call({ triggerWord: 'mystyle' });
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('boom');
  });
});
