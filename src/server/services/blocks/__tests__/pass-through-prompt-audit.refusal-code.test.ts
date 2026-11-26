import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ModerationModule from '~/server/integrations/moderation';
import type * as FliptModule from '~/server/flipt/client';
import type * as PromptOriginModule from '~/server/services/orchestrator/prompt-origin';

/**
 * An App Block prompt refusal reaches the app as a code it can branch on, with the refusal reasons
 * and never the on-site account-status wording; the gate's own decision and recording are
 * unchanged. Runs the REAL gate (`auditPromptServer`, `classifyPromptServer` and the word lists);
 * only the external classifier, the flag and I/O are mocked.
 *
 * The refused prompt is the existing gate fixture from `promptAuditing.classify.test.ts`: a benign
 * prompt the classifier flags as `violence`. No refused text is authored here.
 */

const h = vi.hoisted(() => ({
  moderatePrompt: vi.fn(async () => ({ flagged: false, categories: [] as string[] })),
  configured: vi.fn(() => true),
  variant: vi.fn(async (..._args: [string, string?]): Promise<string | null> => null),
  prohibited: vi.fn(),
}));

vi.mock('~/server/integrations/moderation', async (importOriginal) => ({
  ...(await importOriginal<typeof ModerationModule>()),
  extModeration: { moderatePrompt: h.moderatePrompt },
  isExternalModerationConfigured: () => h.configured(),
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptModule>()),
  getFliptVariant: (flag: string, entity?: string) => h.variant(flag, entity),
}));
vi.mock('~/server/services/blocklist.service', () => ({
  stripBenignPhrases: vi.fn(async (text?: string) => text),
}));
vi.mock('~/server/redis/fail-open-log', () => ({ logSysRedisFailOpen: vi.fn() }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/services/user.service', () => ({ updateUserById: vi.fn(async () => undefined) }));
vi.mock('~/server/auth/session-invalidation', () => ({
  refreshSession: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('~/server/services/user-restriction.service', () => ({
  applyPendingReviewMute: vi.fn(async () => ({ muted: false })),
}));
vi.mock('~/server/utils/cache-helpers', () => ({
  fetchThroughCache: vi.fn(),
  bustFetchThroughCache: vi.fn(),
}));
vi.mock('~/server/services/orchestrator/prompt-origin', async (importOriginal) => ({
  ...(await importOriginal<typeof PromptOriginModule>()),
  attachPromptOrigin: vi.fn(async () => undefined),
}));

import { env } from '~/env/server';
import {
  AppBlockPromptRefusalError,
  auditAppBlockPrompt,
  auditPassThroughPrompts,
  getPassThroughPromptAuditMode,
} from '~/server/services/blocks/pass-through-prompt-audit';
import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';
import { appSubmitFailureFromResult } from '~/shared/constants/app-telemetry.constants';
import {
  PROMPT_CHECK_UNAVAILABLE_ERROR_CODE,
  PROMPT_POLICY_REFUSED_ERROR_CODE,
} from '~/shared/constants/block-scope.constants';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import '~/__tests__/mocks/db.mock';

const sysRedis = redisMock.sysRedis;
const PROMPT = 'a quiet harbour at dusk';
const APP = 'apb_test';

const flagsViolence = () =>
  h.moderatePrompt.mockImplementation(async () => ({ flagged: true, categories: ['violence'] }));

const gateOptions = (over: Partial<Parameters<typeof auditPromptServer>[0]> = {}) => ({
  prompt: PROMPT,
  userId: 5,
  isGreen: false,
  ...over,
});

const ctx = {
  userId: 5,
  appBlockId: APP,
  isGreen: false,
  loadIsModerator: async () => false,
};
const steps = [{ $type: 'videoGen', input: { prompt: PROMPT } }];

const auditRows = () =>
  loggingMock.logToAxiom.mock.calls
    .map(([row]) => row as Record<string, unknown>)
    .filter((row) => row.name === 'app-block-pass-through-prompt-audit');

async function refusalOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error('expected a refusal');
}

beforeEach(() => {
  vi.clearAllMocks();
  h.moderatePrompt.mockImplementation(async () => ({ flagged: false, categories: [] }));
  h.configured.mockImplementation(() => true);
  h.variant.mockImplementation(async () => null);
  sysRedis.exists.mockResolvedValue(1);
  sysRedis.lRange.mockResolvedValue([]);
});

describe('log mode, the positive control', () => {
  it('control: the fixture is a prompt the real gate refuses', async () => {
    flagsViolence();
    await expect(auditPromptServer(gateOptions())).rejects.toThrow(
      /^Your prompt was flagged: violence$/
    );
  });

  it('records one wouldRefuse row for the refused fixture', async () => {
    flagsViolence();
    await auditPassThroughPrompts({ ...ctx, steps }, 'log');
    await vi.waitFor(() => expect(auditRows()).toHaveLength(1));
    expect(auditRows()[0]).toMatchObject({
      wouldRefuse: true,
      outcome: 'hard',
      source: 'external',
    });
  });

  it('records wouldRefuse false for an allowed prompt', async () => {
    await auditPassThroughPrompts({ ...ctx, steps }, 'log');
    await vi.waitFor(() => expect(auditRows()).toHaveLength(1));
    expect(auditRows()[0]).toMatchObject({ wouldRefuse: false, outcome: 'pass' });
  });

  it("an errored check is outcome 'error', never 'pass', and enforce would refuse it", async () => {
    h.moderatePrompt.mockImplementation(async () => {
      throw new Error('gateway timeout');
    });
    await auditPassThroughPrompts({ ...ctx, steps }, 'log');
    await vi.waitFor(() => expect(auditRows()).toHaveLength(1));
    expect(auditRows()[0]).toMatchObject({
      outcome: 'error',
      wouldRefuse: true,
      payload: expect.objectContaining({ externalError: true }),
    });
  });

  it("an unconfigured classifier is outcome 'unconfigured', and enforce would refuse it", async () => {
    h.configured.mockImplementation(() => false);
    await auditPassThroughPrompts({ ...ctx, steps }, 'log');
    await vi.waitFor(() => expect(auditRows()).toHaveLength(1));
    expect(auditRows()[0]).toMatchObject({
      outcome: 'unconfigured',
      wouldRefuse: true,
      payload: expect.objectContaining({ externalSkipped: true }),
    });
  });
});

describe('enforce, the codes', () => {
  it('a refused prompt is the policy code, with the reasons only', async () => {
    flagsViolence();
    const e = await refusalOf(auditPassThroughPrompts({ ...ctx, steps }, 'enforce'));
    expect(e).toBeInstanceOf(AppBlockPromptRefusalError);
    expect(e).toMatchObject({
      errorCode: PROMPT_POLICY_REFUSED_ERROR_CODE,
      appError: 'Your prompt was flagged: violence',
    });
  });

  it('never carries the account-status wording to the app', async () => {
    flagsViolence();
    // Enough earlier blocks that the gate appends its escalation wording to its own message.
    sysRedis.lLen.mockResolvedValue(100);
    const e = (await refusalOf(
      auditAppBlockPrompt({ ...gateOptions(), appBlockId: APP, stepType: 'videoGen' })
    )) as AppBlockPromptRefusalError;
    expect(e.message).toMatch(/Your account/);
    expect(e.appError).toBe('Your prompt was flagged: violence');
    expect(e.appError).not.toMatch(/account|review|muted/i);
  });

  it('an errored check is the unavailable code, with the site switch at its schema default', async () => {
    // Read through the real env schema with the variable unset (`~/__tests__/mocks/env.mock`).
    expect(env.PROMPT_CHECK_FAIL_CLOSED).toBe(true);
    h.moderatePrompt.mockImplementation(async () => {
      throw new Error('gateway timeout');
    });
    const e = await refusalOf(auditPassThroughPrompts({ ...ctx, steps }, 'enforce'));
    expect(e).toMatchObject({ errorCode: PROMPT_CHECK_UNAVAILABLE_ERROR_CODE });
  });

  it('an unconfigured classifier refuses a clean prompt with the unavailable code', async () => {
    h.configured.mockImplementation(() => false);
    const e = await refusalOf(auditPassThroughPrompts({ ...ctx, steps }, 'enforce'));
    expect(e).toMatchObject({ errorCode: PROMPT_CHECK_UNAVAILABLE_ERROR_CODE });
  });

  it('a refused prompt with the classifier unconfigured is still recorded and gets the policy code', async () => {
    flagsViolence();
    h.configured.mockImplementation(() => false);
    const e = await refusalOf(auditPassThroughPrompts({ ...ctx, steps }, 'enforce'));
    expect(e).toMatchObject({ errorCode: PROMPT_POLICY_REFUSED_ERROR_CODE });
    expect(sysRedis.lPush).toHaveBeenCalledTimes(1);
  });

  it('control: a clean prompt passes', async () => {
    await expect(auditPassThroughPrompts({ ...ctx, steps }, 'enforce')).resolves.toBeUndefined();
  });

  it('the unconfigured refusal is pass-through only: a main-gate kind still passes', async () => {
    h.configured.mockImplementation(() => false);
    await expect(
      auditAppBlockPrompt({ ...gateOptions(), appBlockId: APP, stepType: 'textToImage' })
    ).resolves.toBeUndefined();
  });
});

describe('the stored block names the app', () => {
  it('records the app on the entry the mute count reads', async () => {
    flagsViolence();
    await refusalOf(
      auditAppBlockPrompt({ ...gateOptions(), appBlockId: APP, stepType: 'videoGen' })
    );
    const stored = JSON.parse(sysRedis.lPush.mock.calls[0][1] as string);
    expect(stored.origin).toEqual({
      incomplete: true,
      app: { appBlockId: APP, stepType: 'videoGen' },
    });
  });

  it("records it on a moderator's refusal too, where the origin lookup is skipped", async () => {
    flagsViolence();
    await refusalOf(
      auditAppBlockPrompt({
        ...gateOptions({ isModerator: true }),
        appBlockId: APP,
        stepType: 'videoGen',
      })
    );
    const stored = JSON.parse(sysRedis.lPush.mock.calls[0][1] as string);
    expect(stored.origin.app).toEqual({ appBlockId: APP, stepType: 'videoGen' });
  });

  it('the gate decides and records the same with and without the app', async () => {
    flagsViolence();
    const plain = await refusalOf(auditPromptServer(gateOptions()));
    const plainEntry = JSON.parse(sysRedis.lPush.mock.calls[0][1] as string);
    vi.clearAllMocks();
    flagsViolence();
    sysRedis.exists.mockResolvedValue(1);
    sysRedis.lRange.mockResolvedValue([]);
    const viaApp = (await refusalOf(
      auditAppBlockPrompt({ ...gateOptions(), appBlockId: APP, stepType: 'videoGen' })
    )) as AppBlockPromptRefusalError;
    const appEntry = JSON.parse(sysRedis.lPush.mock.calls[0][1] as string);

    expect(viaApp.message).toBe((plain as Error).message);
    // The only differences allowed: `origin.app`, and the per-entry id and time.
    const strip = ({ id: _id, time: _time, origin, ...rest }: Record<string, unknown>) => ({
      ...rest,
      origin: { ...(origin as object), app: undefined },
    });
    expect(strip(appEntry)).toEqual(strip(plainEntry));
  });
});

describe('the flag, per user', () => {
  const FLAG = 'app-block-pass-through-prompt-audit';

  it("reads the user's own variant, so one account can be held in enforce", async () => {
    h.variant.mockImplementation(async (_f, entity) => (entity === '42' ? 'enforce' : 'log'));
    expect(await getPassThroughPromptAuditMode(42)).toBe('enforce');
    expect(await getPassThroughPromptAuditMode(43)).toBe('log');
    expect(h.variant).toHaveBeenCalledWith(FLAG, '42');
  });

  it("one user's enforce never becomes another user's fallback", async () => {
    h.variant.mockImplementation(async (_f, entity) => (entity === '42' ? 'enforce' : 'log'));
    await getPassThroughPromptAuditMode(42);
    // Flipt unreadable for every read: the fallback is the last GLOBAL mode, not user 42's.
    h.variant.mockImplementation(async () => null);
    expect(await getPassThroughPromptAuditMode(43)).toBe('log');
  });

  it("a user's segment cannot make the audit laxer than the global mode", async () => {
    h.variant.mockImplementation(async (_f, entity) => (entity === '42' ? 'off' : 'enforce'));
    expect(await getPassThroughPromptAuditMode(42)).toBe('enforce');
    h.variant.mockImplementation(async (_f, entity) => (entity === '42' ? 'log' : 'enforce'));
    expect(await getPassThroughPromptAuditMode(42)).toBe('enforce');
  });

  it("control: a user's segment can make it stricter", async () => {
    h.variant.mockImplementation(async (_f, entity) => (entity === '42' ? 'enforce' : 'log'));
    expect(await getPassThroughPromptAuditMode(42)).toBe('enforce');
  });
});

describe('submit telemetry', () => {
  const failed = (errorCode?: string) => ({
    snapshot: {
      workflowId: 'failed',
      status: 'failed',
      error: 'Your prompt was flagged: violence',
      ...(errorCode ? { errorCode } : {}),
    },
  });

  it('control: the same snapshot without a code classifies as other', () => {
    expect(appSubmitFailureFromResult(failed())).toBe('other');
  });

  it('a policy refusal is prompt_refused, and an unavailable check is server_error', () => {
    expect(appSubmitFailureFromResult(failed(PROMPT_POLICY_REFUSED_ERROR_CODE))).toBe(
      'prompt_refused'
    );
    expect(appSubmitFailureFromResult(failed(PROMPT_CHECK_UNAVAILABLE_ERROR_CODE))).toBe(
      'server_error'
    );
  });
});
