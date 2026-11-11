import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BridgeAuthModule from '~/server/services/blocks/block-bridge-auth.service';
import type * as TokenAccessModule from '~/server/services/blocks/block-token-access.service';
import type * as FlagModule from '~/server/services/app-blocks-flag';
import type * as FeatureFlagsModule from '~/server/services/feature-flags.service';
import type * as RateLimitModule from '~/server/utils/block-catalog-rate-limit';
import type * as FliptModule from '~/server/flipt/client';

/**
 * The App Blocks pass-through prompt gate, through `blocksRouter`: a text-in generation
 * step submitted as a pass-through `kind:'step'`, a confirmed step or a `kind:'workflow'`
 * is audited before any quote or reservation when the flag says `enforce`, and only
 * observed when it says `log`.
 */

const h = vi.hoisted(() => ({
  authorize: vi.fn(),
  assertEnabled: vi.fn(async () => undefined),
  confirmedStepFlag: vi.fn(async () => true),
  trainingFlag: vi.fn(async () => true),
  getOrchestratorToken: vi.fn(async () => 'orch-token'),
  submitWorkflow: vi.fn(),
  audit: vi.fn(
    async (_input: {
      prompt: string;
      negativePrompt?: string;
      userId: number;
      isGreen: boolean;
      isModerator?: boolean;
    }) => undefined
  ),
  classify: vi.fn(
    async (_input: {
      prompt: string;
    }): Promise<{
      outcome: 'pass' | 'soft' | 'hard';
      source: string | null;
      externalError: null;
    }> => ({ outcome: 'pass', source: null, externalError: null })
  ),
  variant: vi.fn(async (): Promise<string | null> => null),
  getUserById: vi.fn(async () => ({ id: 42, isModerator: false })),
  catalogRate: vi.fn(async () => ({ allowed: true })),
  buzzAccounts: vi.fn(async (): Promise<Record<string, number>> => ({ blue: 0, green: 5000 })),
}));

vi.mock('~/server/services/blocks/block-bridge-auth.service', async (importOriginal) => ({
  ...(await importOriginal<typeof BridgeAuthModule>()),
  authorizeBlockBridgeToken: (...a: unknown[]) => h.authorize(...a),
}));
vi.mock('~/server/services/blocks/block-token-access.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TokenAccessModule>()),
  assertAppBlocksEnabledForTokenUser: (...a: unknown[]) => h.assertEnabled(...(a as [])),
}));
vi.mock('~/server/services/app-blocks-flag', async (importOriginal) => ({
  ...(await importOriginal<typeof FlagModule>()),
  isAppBlocksConfirmedStepEnabled: (...a: unknown[]) => h.confirmedStepFlag(...(a as [])),
  isAppBlocksTrainingKindEnabled: (...a: unknown[]) => h.trainingFlag(...(a as [])),
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  getFeatureFlagsLazy: () => ({}),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: () => h.getOrchestratorToken(),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  submitWorkflow: (...a: unknown[]) => h.submitWorkflow(...a),
  getWorkflow: vi.fn(),
  cancelWorkflow: vi.fn(),
  queryWorkflows: vi.fn(),
  deleteWorkflow: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: (input: Parameters<typeof h.audit>[0]) => h.audit(input),
  classifyPromptServer: (input: { prompt: string }) => h.classify(input),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const real = await importOriginal<typeof FliptModule>();
  return {
    ...real,
    getFliptVariant: async (flag: string) =>
      flag === real.FLIPT_FEATURE_FLAGS.APP_BLOCK_PASS_THROUGH_PROMPT_AUDIT ? h.variant() : null,
  };
});
vi.mock('~/server/services/user.service', () => ({
  getUserById: () => h.getUserById(),
}));
vi.mock('~/server/services/subscriptions.service', () => ({
  getHighestTierSubscription: vi.fn(async () => null),
}));
vi.mock('~/server/utils/block-catalog-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof RateLimitModule>()),
  checkBlockCatalogRateLimit: (...a: unknown[]) => h.catalogRate(...(a as [])),
}));
vi.mock('~/server/services/buzz.service', () => ({
  getUserBuzzAccounts: () => h.buzzAccounts(),
  getUserBuzzAccount: vi.fn(),
  getUserBuzzTransactions: vi.fn(),
  getDailyCompensationRewardByUser: vi.fn(),
}));
vi.mock('~/server/middleware.trpc', async () => {
  const { middleware } = await import('~/server/trpc');
  return { rateLimit: () => middleware(({ next }) => next()) };
});

import { blocksRouter } from '../blocks.router';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const VIEWER = 42;
const REFUSED = 'prompt refused';

const store = new Map<string, string>();
function installRedis() {
  const r = redisMock.sysRedis;
  r.get.mockImplementation(async (k: string) => store.get(k) ?? null);
  r.set.mockImplementation(async (k: string, v: string, opts?: { NX?: boolean; XX?: boolean }) => {
    if (opts?.NX && store.has(k)) return null;
    if (opts?.XX && !store.has(k)) return null;
    store.set(k, String(v));
    return 'OK';
  });
  r.getDel.mockImplementation(async (k: string) => {
    const v = store.get(k) ?? null;
    store.delete(k);
    return v;
  });
  r.del.mockImplementation(async (k: string) => (store.delete(k) ? 1 : 0));
  r.incrBy.mockImplementation(async (k: string, n: number) => {
    const v = Number(store.get(k) ?? 0) + n;
    store.set(k, String(v));
    return v;
  });
  r.expire.mockImplementation(async () => true);
  r.ttl.mockImplementation(async () => 3600);
}

function claims(over: Record<string, unknown> = {}) {
  return {
    iss: 'civitai',
    aud: 'civitai-app-block',
    sub: `user:${VIEWER}`,
    iat: 0,
    exp: 0,
    jti: 'jti',
    blockId: 'blk_test',
    appId: 'app_test',
    appBlockId: 'apb_test',
    blockInstanceId: 'page_apb_test',
    ctx: { slotId: 'app.page', entityType: 'none' },
    scopes: ['ai:write:budgeted'],
    buzzBudget: 50,
    maxBrowsingLevel: 1,
    ...over,
  };
}

function ctx(sessionUserId?: number) {
  return {
    acceptableOrigin: true,
    user:
      sessionUserId == null
        ? undefined
        : { id: sessionUserId, isModerator: false, onboarding: 0xffff, muted: false },
    apiKeyId: null,
    tokenScope: TokenScope.Full,
    req: { headers: {} } as never,
    res: { setHeader: () => undefined } as never,
    cache: { edgeTTL: 0 },
    features: {} as never,
    track: undefined,
  };
}
const caller = (sessionUserId?: number) => blocksRouter.createCaller(ctx(sessionUserId) as never);

const submit = (body: Record<string, unknown>) =>
  caller().submitWorkflow({ blockToken: 't', body: body as never });

const stepBody = (input: Record<string, unknown>, $type = 'videoGen') => ({
  kind: 'step',
  $type,
  input,
  maxBuzz: 40,
});
const workflowBody = (steps: unknown[], args?: Record<string, unknown>) => ({
  kind: 'workflow',
  steps,
  ...(args ? { arguments: args } : {}),
});
const repeatOverFrames = (template: Record<string, unknown>) => ({
  $type: 'repeat',
  name: 'loop',
  input: { for: { $ref: '$arguments', path: 'frames', as: 'frame' }, template },
});
const NON_LITERAL =
  'a generation step’s prompt must be a literal string so it can be moderated before submit';
const whatIfCalls = () =>
  h.submitWorkflow.mock.calls.filter(
    ([args]) => (args as { query?: { whatif?: boolean } }).query?.whatif
  );

beforeEach(() => {
  // Only the submit's account-restriction read gets a row; other user reads keep the default.
  dbMock.dbWrite.user.findUnique.mockImplementation((async (args: {
    select?: Record<string, boolean>;
  }) =>
    Object.keys(args.select ?? {})
      .sort()
      .join() === 'bannedAt,muted'
      ? { muted: false, bannedAt: null }
      : undefined) as never);
  store.clear();
  for (const fn of Object.values(h)) fn.mockClear();
  loggingMock.logToAxiom.mockClear();
  installRedis();
  h.authorize.mockImplementation(async () => claims());
  // The audit refuses exactly one word, so a mixed body shows which text reached it.
  h.audit.mockImplementation(async ({ prompt }) => {
    if (prompt.includes('badword')) throw new Error(REFUSED);
  });
  h.variant.mockImplementation(async () => 'enforce');
  h.submitWorkflow.mockImplementation(async (args: { query?: { whatif?: boolean } }) => {
    if (args.query?.whatif) return { id: 'whatif', cost: { total: 30 } };
    throw new Error('no real submit expected in this file');
  });
  dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue(null);
});

describe('enforce: a pass-through `kind:step` generation', () => {
  it('refuses a videoGen prompt the audit blocks, before any quote or reservation', async () => {
    await expect(submit(stepBody({ engine: 'wan', prompt: 'a badword scene' }))).rejects.toThrow(
      REFUSED
    );
    expect(h.submitWorkflow).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });

  it('lets a clean prompt through to the quote', async () => {
    await submit(stepBody({ engine: 'wan', prompt: 'a calm lake' })).catch(() => undefined);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'wan\na calm lake' }));
    expect(whatIfCalls()).toHaveLength(1);
  });

  it('audits an imageGen prompt nested in an engine field', async () => {
    await expect(
      submit(stepBody({ engine: 'kling-v4', multiPrompt: [{ prompt: 'badword' }] }, 'imagegen'))
    ).rejects.toThrow(REFUSED);
  });

  it('control: a step type outside the list is not audited', async () => {
    await submit(stepBody({ prompt: 'badword' }, 'convertImage')).catch(() => undefined);
    expect(h.audit).not.toHaveBeenCalled();
    expect(whatIfCalls()).toHaveLength(1);
  });
});

describe('enforce: a confirmed pass-through step', () => {
  it('is audited before its quote is read', async () => {
    const body = { ...stepBody({ prompt: 'badword' }), quoteId: `sq_${'a'.repeat(32)}` };
    await expect(submit(body)).rejects.toThrow(REFUSED);
  });

  it('control: with a clean prompt it reaches the quote lookup', async () => {
    const body = { ...stepBody({ prompt: 'a calm lake' }), quoteId: `sq_${'a'.repeat(32)}` };
    await expect(submit(body)).rejects.toThrow(/quote not found/);
  });
});

describe('enforce: a `kind:workflow`', () => {
  it('refuses a blocked prompt in a repeat template', async () => {
    await expect(
      submit(
        workflowBody([repeatOverFrames({ $type: 'videoGen', input: { prompt: 'badword' } })], {
          frames: ['a'],
        })
      )
    ).rejects.toThrow(REFUSED);
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    ['an argument', { $ref: '$arguments', path: 'prompt' }],
    ['another step’s output', { $ref: 'chat', path: 'output.text' }],
  ])('refuses a prompt that is %s, before the audit or the orchestrator', async (_label, ref) => {
    await expect(
      submit(
        workflowBody(
          [
            { name: 'chat', $type: 'chatCompletion', input: { messages: [] } },
            { name: 'vid', $type: 'videoGen', input: { engine: 'wan', prompt: ref } },
          ],
          { prompt: 'x' }
        )
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: NON_LITERAL });
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('control: a reference to an image, beside a literal prompt, is audited and passes', async () => {
    await submit(
      workflowBody([
        { name: 'gen', $type: 'imageGen', input: { engine: 'flux', prompt: 'a fox' } },
        {
          name: 'vid',
          $type: 'videoGen',
          input: {
            engine: 'wan',
            prompt: 'it runs',
            images: [{ $ref: 'gen', path: 'output.images[0].url' }],
          },
        },
      ])
    ).catch(() => undefined);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(whatIfCalls()).toHaveLength(1);
  });
});

describe('log mode', () => {
  beforeEach(() => {
    h.variant.mockImplementation(async () => 'log');
    h.classify.mockImplementation(async () => ({
      outcome: 'hard',
      source: 'regex',
      externalError: null,
    }));
  });

  it('never refuses: a prompt enforce would block, and a referenced prompt, both reach the quote', async () => {
    await submit(stepBody({ engine: 'wan', prompt: 'a badword scene' })).catch(() => undefined);
    await submit(
      workflowBody([{ $type: 'videoGen', input: { prompt: { $ref: '$arguments', path: 'p' } } }], {
        p: 'x',
      })
    ).catch(() => undefined);
    expect(h.audit).not.toHaveBeenCalled();
    expect(whatIfCalls()).toHaveLength(2);
  });

  it('logs what enforce would have done, without the prompt text', async () => {
    await submit(stepBody({ engine: 'wan', prompt: 'a badword scene' })).catch(() => undefined);
    await vi.waitFor(() =>
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'app-block-pass-through-prompt-audit',
          appBlockId: 'apb_test',
          stepTypes: 'videogen',
          literal: true,
          outcome: 'hard',
          wouldRefuse: true,
        })
      )
    );
    const logged = JSON.stringify(loggingMock.logToAxiom.mock.calls.map(([data]) => data));
    expect(logged).not.toContain('badword');
  });
});

describe('off', () => {
  it('neither audits nor observes', async () => {
    h.variant.mockImplementation(async () => 'off');
    await submit(stepBody({ prompt: 'badword' })).catch(() => undefined);
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.classify).not.toHaveBeenCalled();
    expect(whatIfCalls()).toHaveLength(1);
  });
});

describe('an unreadable flag', () => {
  it('keeps the last mode read instead of dropping to off', async () => {
    await submit(stepBody({ prompt: 'a calm lake' })).catch(() => undefined);
    h.variant.mockImplementation(async () => null);
    await expect(submit(stepBody({ prompt: 'badword' }))).rejects.toThrow(REFUSED);
  });
});

describe('enforce: what reaches the audit', () => {
  it('sends the negative prompt, the viewer, and their moderator status', async () => {
    await submit(stepBody({ prompt: 'a calm lake', negativePrompt: 'blurry' })).catch(
      () => undefined
    );
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ negativePrompt: 'blurry', userId: 42, isModerator: false })
    );
  });

  it('reads moderator status from the viewer', async () => {
    h.getUserById.mockImplementation(async () => ({ id: 42, isModerator: true }));
    await submit(stepBody({ prompt: 'a calm lake' })).catch(() => undefined);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ isModerator: true }));
    h.getUserById.mockImplementation(async () => ({ id: 42, isModerator: false }));
  });

  it('refuses a prompt over the moderation limit, before the audit or the orchestrator', async () => {
    await expect(submit(stepBody({ prompt: 'a calm lake '.repeat(2_000) }))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('moderation limit'),
    });
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });
});

describe('log mode, what it records', () => {
  beforeEach(() => {
    h.variant.mockImplementation(async () => 'log');
    h.classify.mockImplementation(async () => ({
      outcome: 'pass',
      source: null,
      externalError: null,
    }));
  });

  it('does not hold the submit for the classifier', async () => {
    let release: () => void = () => undefined;
    h.classify.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ outcome: 'pass', source: null, externalError: null });
        })
    );
    await submit(stepBody({ prompt: 'a calm lake' })).catch(() => undefined);
    expect(whatIfCalls()).toHaveLength(1);
    release();
  });

  it('logs a clean prompt as one enforce would pass', async () => {
    await submit(stepBody({ prompt: 'a calm lake' })).catch(() => undefined);
    await vi.waitFor(() =>
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: 'pass', literal: true, wouldRefuse: false })
      )
    );
  });

  it('logs a referenced prompt as not literal and as one enforce would refuse', async () => {
    await submit(
      workflowBody([{ $type: 'videoGen', input: { prompt: { $ref: '$arguments', path: 'p' } } }], {
        p: 'x',
      })
    ).catch(() => undefined);
    await vi.waitFor(() =>
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ literal: false, argumentRefs: 1, wouldRefuse: true })
      )
    );
  });

  it('a classifier failure logs an error and never fails the submit', async () => {
    h.classify.mockImplementation(async () => {
      throw new Error('classifier down');
    });
    await submit(stepBody({ prompt: 'a calm lake' })).catch(() => undefined);
    expect(whatIfCalls()).toHaveLength(1);
    await vi.waitFor(() =>
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'app-block-pass-through-prompt-audit', type: 'error' })
      )
    );
  });
});

describe('a training run’s sample prompts', () => {
  const trainingBody = (samplePrompts: string[]) => ({
    kind: 'training',
    items: [{ air: 'K1.jpeg', caption: 'a' }],
    engine: 'ai-toolkit',
    model: 'sdxl',
    params: {
      engine: 'ai-toolkit',
      ecosystem: 'sdxl',
      epochs: 5,
      resolution: 1024,
      lr: 0.0001,
      textEncoderLr: null,
      trainTextEncoder: false,
      lrScheduler: 'cosine',
      optimizerType: 'adamw8bit',
      networkDim: 32,
      networkAlpha: 16,
      noiseOffset: null,
      minSnrGamma: null,
      flipAugmentation: false,
      shuffleTokens: false,
      keepTokens: 0,
    },
    triggerWord: 'mychar',
    samplePrompts,
    quoteId: `tq_${'a'.repeat(32)}`,
  });

  it('enforce: are audited before the quote is read', async () => {
    await expect(submit(trainingBody(['mychar on a beach', 'mychar badword']))).rejects.toThrow(
      REFUSED
    );
  });

  it('control: clean or blank prompts reach the quote lookup', async () => {
    const clean = submit(trainingBody(['mychar on a beach']));
    await expect(clean).rejects.toThrow(/quote not found/);
    await expect(clean).rejects.not.toThrow(REFUSED);
    const blank = submit(trainingBody(['', '  ']));
    await expect(blank).rejects.toThrow(/quote not found/);
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'mychar on a beach', userId: VIEWER, isGreen: true })
    );
  });

  it('enforce: a pass-through training step’s sample prompts are audited too', async () => {
    const body = stepBody(
      { engine: 'ai-toolkit', samples: { prompts: ['mychar badword'] } },
      'training'
    );
    await expect(submit(body)).rejects.toThrow(REFUSED);
    expect(whatIfCalls()).toHaveLength(0);
  });

  it('a mature block’s prompts get the mature audit', async () => {
    h.authorize.mockImplementation(async () => claims({ maxBrowsingLevel: 31 }));
    await submit(trainingBody(['mychar on a beach'])).catch(() => undefined);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ isGreen: false }));
  });

  it('log mode: logs what enforce would have done, without the prompt text', async () => {
    h.variant.mockImplementation(async () => 'log');
    h.classify.mockImplementation(async () => ({
      outcome: 'hard',
      source: 'regex',
      externalError: null,
    }));
    await expect(submit(trainingBody(['mychar badword']))).rejects.not.toThrow(REFUSED);
    await vi.waitFor(() =>
      expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'app-block-pass-through-prompt-audit',
          stepTypes: 'trainingsampleprompts',
          wouldRefuse: true,
        })
      )
    );
    expect(h.classify).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'mychar badword' }));
    expect(h.audit).not.toHaveBeenCalled();
    const logged = JSON.stringify(loggingMock.logToAxiom.mock.calls.map(([data]) => data));
    expect(logged).not.toContain('badword');
  });
});
