import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type * as UserService from '~/server/services/user.service';

/** The Training Studio's call into the trigger word check (real rule, classifier mocked): how its
 *  verdicts reach the Studio. */

const classifyPromptExternally = vi.hoisted(() =>
  vi.fn(async (_prompt: string, _source?: string) => ({
    categories: [] as string[],
    externalError: null,
  }))
);
const auditPromptServer = vi.hoisted(() => vi.fn(async (_options: unknown) => undefined));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  classifyPromptExternally,
  auditPromptServer,
}));
const gate = vi.hoisted(() => ({ allow: vi.fn() }));
const getUserSettings = vi.hoisted(() => vi.fn(async (_userId: number) => ({} as unknown)));
const patchUserSettings = vi.hoisted(() =>
  vi.fn(async (_userId: number, _patch: { mergeInto: Record<string, object> }) => undefined)
);
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  getUserSettings,
  patchUserSettings,
}));
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
import licenseHandler from '~/pages/api/training-studio/license';
import { assertTrainingLicenseAccepted } from '~/server/services/generation-license.service';
import { getTrainingLicenseTerms } from '~/shared/constants/generation-license.constants';

async function call(body: unknown, method = 'POST', endpoint: unknown = handler) {
  const req = { method, body };
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
  await (endpoint as (req: unknown, r: typeof res) => Promise<unknown>)(req, res);
  return res;
}

describe('POST /api/training-studio/check-text', () => {
  beforeEach(() => {
    classifyPromptExternally.mockClear();
    auditPromptServer.mockReset().mockResolvedValue(undefined);
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
    ['an edit prompt posing as a trigger word', { triggerWord: 'ok', editPrompt: 'unchecked' }],
  ])('answers %s as invalid, without running the rule', async (_l, body) => {
    const res = await call(body);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid text to check.' });
    expect(classifyPromptExternally).not.toHaveBeenCalled();
  });

  it('answers an unexpected failure as a generic server error, never as ok', async () => {
    classifyPromptExternally.mockRejectedValueOnce(new Error('boom'));
    const res = await call({ triggerWord: 'mystyle' });
    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('boom');
  });

  it("runs an edit prompt through the generator's prompt check, not the trigger word rule", async () => {
    const image = 'https://orch.example/v2/consumer/blobs/start.png';
    const res = await call({ editPrompt: 'turn her around', inputImages: [image] });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(auditPromptServer).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'turn her around', userId: 7, inputImages: [image] })
    );
    expect(classifyPromptExternally).not.toHaveBeenCalled();
  });

  it('passes a refused edit prompt on as a 400 with its reason', async () => {
    const { TRPCError } = await import('@trpc/server');
    auditPromptServer.mockRejectedValueOnce(
      new TRPCError({ code: 'BAD_REQUEST', message: 'Your prompt was flagged.' })
    );
    const res = await call({ editPrompt: 'something bad' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: 'Your prompt was flagged.' });
  });

  it('refuses a run on a model whose licence the user has not accepted, as a 400 the Studio shows', async () => {
    getUserSettings.mockResolvedValueOnce({});
    const res = await call({ licenseEcosystem: 'minimaxh3image' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: expect.stringMatching(/licence terms before training/) });
  });

  it('passes the licence check once the user has accepted', async () => {
    const terms = getTrainingLicenseTerms('minimaxh3image')!;
    getUserSettings.mockResolvedValueOnce({
      generationLicenseAcceptances: {
        [terms.key]: { version: terms.version, acceptedAt: new Date() },
      },
    });
    const res = await call({ licenseEcosystem: 'minimaxh3image' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

// The Studio's Accept: what it records is what the training submit checks, so Start unblocks.
describe('/api/training-studio/license', () => {
  let settings: Record<string, Record<string, unknown>> = {};
  const license = (method: 'GET' | 'POST', body?: unknown) => call(body, method, licenseHandler);
  beforeEach(() => {
    settings = {};
    gate.allow.mockReset().mockResolvedValue(true);
    getUserSettings.mockImplementation(async () => settings);
    patchUserSettings.mockClear().mockImplementation(async (_userId, { mergeInto }) => {
      for (const [key, value] of Object.entries(mergeInto))
        settings[key] = { ...settings[key], ...value };
    });
  });
  afterEach(() => {
    getUserSettings.mockImplementation(async () => ({}));
  });

  it('records an acceptance the training submit then honours', async () => {
    await expect(
      assertTrainingLicenseAccepted({ ecosystem: 'minimaxh3image', userId: 7 })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await license('GET')).body).toEqual({ pending: ['minimaxh3image'] });

    const res = await license('POST', { ecosystem: 'minimaxh3image' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true });

    expect((await license('GET')).body).toEqual({ pending: [] });
    await expect(
      assertTrainingLicenseAccepted({ ecosystem: 'minimaxh3image', userId: 7 })
    ).resolves.toBeUndefined();
  });

  it('refuses a model with no licence, recording nothing', async () => {
    const res = await license('POST', { ecosystem: 'sdxl' });
    expect(res.statusCode).toBe(400);
    expect(patchUserSettings).not.toHaveBeenCalled();
  });
});
