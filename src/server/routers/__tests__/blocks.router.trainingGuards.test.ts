import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BridgeAuthModule from '~/server/services/blocks/block-bridge-auth.service';
import type * as TokenAccessModule from '~/server/services/blocks/block-token-access.service';
import type * as FlagModule from '~/server/services/app-blocks-flag';
import type * as FeatureFlagsModule from '~/server/services/feature-flags.service';
import type * as RateLimitModule from '~/server/utils/block-catalog-rate-limit';

/**
 * ONE trigger-word rule for every App Blocks carrier of a training run, through
 * `blocksRouter`: a pass-through `kind:'step'` training `$type` and every training step
 * of a `kind:'workflow'` (a `repeat` template included) gets the trigger-word check every
 * training path uses, at the estimate and the submit, before any quote or reservation;
 * a trigger word that is not a literal string is refused.
 */

const h = vi.hoisted(() => ({
  authorize: vi.fn(),
  assertEnabled: vi.fn(async () => undefined),
  trainingFlag: vi.fn(async () => true),
  getOrchestratorToken: vi.fn(async () => 'orch-token'),
  submitWorkflow: vi.fn(),
  audit: vi.fn(async () => undefined),
  check: vi.fn(async (_input: { triggerWord: string; log: Record<string, unknown> }) => undefined),
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
  auditPromptServer: (...a: unknown[]) => h.audit(...(a as [])),
}));
vi.mock('~/server/services/orchestrator/training/training-trigger-word-check', () => ({
  assertTrainingTriggerWordAllowed: (input: {
    triggerWord: string;
    log: Record<string, unknown>;
  }) => h.check(input),
}));
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
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const VIEWER = 42;
const NOT_A_STRING = 'a training step’s triggerWord must be a literal string';
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

const estimate = (body: Record<string, unknown>) =>
  caller().estimateWorkflow({ blockToken: 't', body: body as never });
const submit = (body: Record<string, unknown>) =>
  caller().submitWorkflow({ blockToken: 't', body: body as never });

const stepBody = (input: Record<string, unknown>, $type = 'training') => ({
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
/** An `imageResourceTraining` input as the Training Studio sends one: the trigger word is `loraName`. */
const irtInput = (loraName: unknown) => ({
  engine: 'flux2-dev',
  model: 'urn:air:flux2:checkpoint:civitai:1@1',
  loraName,
  trainingData: 'K1.png',
  trainingDataImagesCount: 1,
  samplePrompts: [],
  negativePrompt: '',
});
const NOT_A_STRING_LORA = 'a training step’s loraName must be a literal string';
const repeatOverImages = (template: Record<string, unknown>) => ({
  $type: 'repeat',
  name: 'loop',
  input: { for: { $ref: '$arguments', path: 'images', as: 'item' }, template },
});

beforeEach(() => {
  store.clear();
  for (const fn of Object.values(h)) fn.mockClear();
  installRedis();
  h.authorize.mockImplementation(async () => claims());
  h.audit.mockImplementation(async () => undefined);
  // The shared training check refuses exactly one word, so a mixed body shows which ran.
  h.check.mockImplementation(async ({ triggerWord }) => {
    if (triggerWord === 'badword') throw new Error(REFUSED);
  });
  h.submitWorkflow.mockImplementation(async (args: { query?: { whatif?: boolean } }) => {
    if (args.query?.whatif) return { id: 'whatif', cost: { total: 30 } };
    throw new Error('no real submit expected in this file');
  });
  dbMock.dbWrite.appUserScopeGrant.findUnique.mockResolvedValue(null);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the trigger word of a pass-through `kind:step` training step', () => {
  it('gets the shared training check at the ESTIMATE, before the orchestrator is asked', async () => {
    await expect(estimate(stepBody({ triggerWord: 'badword' }))).rejects.toThrow(REFUSED);
    expect(h.check).toHaveBeenCalledWith({
      triggerWord: 'badword',
      log: expect.objectContaining({
        userId: VIEWER,
        source: 'app-blocks',
        appBlockId: 'apb_test',
      }),
    });
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('is checked at the SUBMIT too, before any quote or reservation', async () => {
    await expect(submit(stepBody({ triggerWord: 'badword' }))).rejects.toThrow(REFUSED);
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('reads the key however it is cased, and whatever the training `$type` casing', async () => {
    await expect(estimate(stepBody({ TriggerWord: 'badword' }, 'Training'))).rejects.toThrow(
      REFUSED
    );
    expect(h.check).toHaveBeenCalledWith(expect.objectContaining({ triggerWord: 'badword' }));
  });

  it('is refused when it is not a literal string, before any check or orchestrator call', async () => {
    await expect(
      estimate(stepBody({ triggerWord: { $ref: '$arguments', path: 'tw' } }))
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: NOT_A_STRING });
    await expect(submit(stepBody({ triggerWord: 7 }))).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: NOT_A_STRING,
    });
    expect(h.check).not.toHaveBeenCalled();
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('checks an `imageResourceTraining` step’s `loraName`, at the estimate and the submit', async () => {
    const body = stepBody(irtInput('badword'), 'imageResourceTraining');
    await expect(estimate(body)).rejects.toThrow(REFUSED);
    await expect(submit(body)).rejects.toThrow(REFUSED);
    expect(h.check).toHaveBeenCalledTimes(2);
    expect(h.check).toHaveBeenCalledWith(expect.objectContaining({ triggerWord: 'badword' }));
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a `loraName` that is not a literal string, before any check or orchestrator call', async () => {
    const body = stepBody(irtInput({ $ref: '$arguments', path: 'name' }), 'imageResourceTraining');
    await expect(estimate(body)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: NOT_A_STRING_LORA,
    });
    await expect(submit(body)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: NOT_A_STRING_LORA,
    });
    expect(h.check).not.toHaveBeenCalled();
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('control: a non-training step with the same field is not checked by this rule', async () => {
    await estimate(stepBody({ triggerWord: 'badword' }, 'wdTagging'));
    expect(h.check).not.toHaveBeenCalled();
  });
});

describe('the trigger word of a training step inside a `kind:workflow`', () => {
  it('is checked at the estimate and the submit, before the orchestrator is asked', async () => {
    const body = workflowBody([
      { name: 'tag', $type: 'wdTagging', input: {} },
      { name: 'train', $type: 'training', input: { triggerWord: 'badword' } },
    ]);
    await expect(estimate(body)).rejects.toThrow(REFUSED);
    await expect(submit(body)).rejects.toThrow(REFUSED);
    expect(h.check).toHaveBeenCalledTimes(2);
    expect(h.check).toHaveBeenCalledWith(expect.objectContaining({ triggerWord: 'badword' }));
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('checks every training step’s word, skipping blank ones and non-training steps', async () => {
    const body = workflowBody([
      { name: 'tag', $type: 'wdTagging', input: { triggerWord: 'nottraining' } },
      { name: 'a', $type: 'training', input: { triggerWord: 'cleanword' } },
      { name: 'b', $type: 'training', input: { triggerWord: '   ' } },
      { name: 'c', $type: 'imageResourceTraining', input: irtInput('badword') },
    ]);
    await expect(estimate(body)).rejects.toThrow(REFUSED);
    expect(h.check.mock.calls.map(([input]) => input.triggerWord)).toEqual([
      'cleanword',
      'badword',
    ]);
  });

  it('checks an `imageResourceTraining` step’s `loraName`, inside a `repeat` too', async () => {
    const direct = workflowBody([{ $type: 'imageResourceTraining', input: irtInput('badword') }]);
    const repeated = workflowBody(
      [repeatOverImages({ $type: 'imageResourceTraining', input: irtInput('badword') })],
      { images: [{ url: 'a' }] }
    );
    for (const body of [direct, repeated]) {
      await expect(estimate(body)).rejects.toThrow(REFUSED);
      await expect(submit(body)).rejects.toThrow(REFUSED);
    }
    expect(h.check).toHaveBeenCalledTimes(4);
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('refuses a `$ref` `loraName` in a workflow, before any check or orchestrator call', async () => {
    const body = workflowBody(
      [{ $type: 'imageResourceTraining', input: irtInput({ $ref: '$arguments', path: 'n' }) }],
      { n: 'badword' }
    );
    await expect(estimate(body)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: NOT_A_STRING_LORA,
    });
    await expect(submit(body)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: NOT_A_STRING_LORA,
    });
    expect(h.check).not.toHaveBeenCalled();
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it('control: a workflow with no training step is never checked by this rule', async () => {
    // Whatever the rest of the estimate answers here, it got past the rule: it priced.
    await estimate(workflowBody([{ $type: 'wdTagging', input: { triggerWord: 'badword' } }])).catch(
      () => undefined
    );
    expect(h.submitWorkflow).toHaveBeenCalled();
    expect(h.check).not.toHaveBeenCalled();
  });

  it('is checked inside a `repeat` template', async () => {
    const body = workflowBody(
      [repeatOverImages({ $type: 'training', input: { triggerWord: 'badword' } })],
      { images: [{ url: 'a' }] }
    );
    await expect(estimate(body)).rejects.toThrow(REFUSED);
    await expect(submit(body)).rejects.toThrow(REFUSED);
    expect(h.check).toHaveBeenCalledWith(expect.objectContaining({ triggerWord: 'badword' }));
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a `$ref` trigger word',
      workflowBody(
        [{ $type: 'training', input: { triggerWord: { $ref: '$arguments', path: 'tw' } } }],
        { tw: 'badword' }
      ),
    ],
    [
      'a `$ref` trigger word inside a `repeat` template',
      workflowBody(
        [
          repeatOverImages({
            $type: 'training',
            input: { triggerWord: { $ref: 'item', path: 'url' } },
          }),
        ],
        { images: [{ url: 'a' }] }
      ),
    ],
    [
      'a training input that is itself a reference',
      workflowBody([{ $type: 'training', input: { $ref: '$arguments', path: 'cfg' } }], {
        cfg: { triggerWord: 'badword' },
      }),
    ],
  ])('refuses %s, before any check or orchestrator call', async (_label, body) => {
    await expect(estimate(body)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: NOT_A_STRING,
    });
    await expect(submit(body)).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: NOT_A_STRING,
    });
    expect(h.check).not.toHaveBeenCalled();
    expect(h.submitWorkflow).not.toHaveBeenCalled();
  });
});
