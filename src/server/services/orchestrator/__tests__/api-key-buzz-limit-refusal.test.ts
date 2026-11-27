import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The orchestrator's refusal of a call that would spend past a key's Buzz limit becomes a FORBIDDEN
 * naming that limit, at every site that maps an orchestrator 403 or 429. It is recognised by the
 * body, so a real insufficient-funds 403 and a scope 403 keep their meaning. The sites run against
 * the shipped list with a FIXTURE pattern added to it.
 */

const FIXTURE = [
  {
    status: 403,
    subject: 'apiKey' as const,
    matches: (body: unknown) => (body as { type?: string })?.type === 'fixture:api-key-buzz-limit',
  },
  {
    status: 429,
    subject: 'oauth' as const,
    matches: (body: unknown) => (body as { type?: string })?.type === 'fixture:oauth-buzz-limit',
  },
];

vi.mock('@civitai/orchestration-client', () => ({
  addWorkflowTag: vi.fn(),
  deleteWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  patchWorkflow: vi.fn(),
  queryWorkflows: vi.fn(),
  removeWorkflowTag: vi.fn(),
  submitWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  refreshBlob: vi.fn(),
  getConsumerBlobUploadUrl: vi.fn(),
  handleError: vi.fn((error) => (error as { detail?: string })?.detail ?? 'orchestrator error'),
  createCivitaiClient: vi.fn().mockReturnValue({
    getConfig: () => ({ baseUrl: 'https://orchestration.civitai.com' }),
  }),
}));

import {
  getConsumerBlobUploadUrl,
  getWorkflow as clientGetWorkflow,
  queryWorkflows as clientQueryWorkflows,
  updateWorkflow as clientUpdateWorkflow,
} from '@civitai/orchestration-client';
import {
  API_KEY_BUZZ_LIMIT_REACHED,
  BUZZ_LIMIT_REFUSALS,
  OFFLINE_BUZZ_CAP_REACHED,
  isApiKeyBuzzLimitRefusal,
} from '~/server/orchestrator/api-key-buzz-limit-refusal';
import { getConsumerBlobUploadUrlService } from '../consumerBlobUpload';
import {
  getWorkflow,
  liftWorkflowMatureRestriction,
  queryWorkflows,
  throwOrchestratorFailure,
} from '../workflows';

const OVER_LIMIT = { status: 403, type: 'fixture:api-key-buzz-limit', detail: 'over limit' };
const OAUTH_OVER_LIMIT = { status: 429, type: 'fixture:oauth-buzz-limit', detail: 'over limit' };
const NO_FUNDS = { status: 403, detail: 'Insufficient buzz' };
const SCOPE = { status: 403, detail: 'Missing scope' };

const failed = (status: number, error: unknown) =>
  ({ data: undefined, error, response: { ok: false, status, headers: new Headers() } } as never);
const caught = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e
  );

beforeEach(() => vi.clearAllMocks());

describe('the matcher', () => {
  it('matches nothing as shipped, so every site maps errors as before', () => {
    expect(isApiKeyBuzzLimitRefusal(403, OVER_LIMIT)).toBeNull();
    expect(isApiKeyBuzzLimitRefusal(429, OAUTH_OVER_LIMIT)).toBeNull();
  });

  it('keys on the body, not the status', () => {
    expect(isApiKeyBuzzLimitRefusal(403, OVER_LIMIT, FIXTURE)).toBe('apiKey');
    expect(isApiKeyBuzzLimitRefusal(429, OAUTH_OVER_LIMIT, FIXTURE)).toBe('oauth');
    expect(isApiKeyBuzzLimitRefusal(403, NO_FUNDS, FIXTURE)).toBeNull();
    expect(isApiKeyBuzzLimitRefusal(403, SCOPE, FIXTURE)).toBeNull();
    expect(isApiKeyBuzzLimitRefusal(429, OVER_LIMIT, FIXTURE)).toBeNull();
    expect(isApiKeyBuzzLimitRefusal(undefined, OVER_LIMIT, FIXTURE)).toBeNull();
  });
});

type Site = [
  string,
  (status: number, body: unknown) => Promise<unknown>,
  /** What a 403 that is not a Buzz-limit refusal gives this site, by its detail. */
  (detail: string) => unknown
];
const badRequest = (message: string) => ({ code: 'BAD_REQUEST', message });
const sites: Site[] = [
  [
    'queryWorkflows',
    (status, body) => {
      vi.mocked(clientQueryWorkflows).mockResolvedValue({
        data: undefined,
        error: body,
      } as never);
      return queryWorkflows({ token: 't', hideMatureContent: false } as never);
    },
    badRequest,
  ],
  [
    'getWorkflow',
    (status, body) => {
      vi.mocked(clientGetWorkflow).mockResolvedValue({ data: undefined, error: body } as never);
      return getWorkflow({ token: 't', path: { workflowId: 'w1' } });
    },
    badRequest,
  ],
  [
    'throwOrchestratorFailure',
    async (status, body) =>
      throwOrchestratorFailure({
        error: body,
        response: { status, headers: new Headers() } as Response,
        message: (body as { detail: string }).detail,
      }),
    badRequest,
  ],
  [
    'liftWorkflowMatureRestriction',
    (status, body) => {
      vi.mocked(clientUpdateWorkflow).mockResolvedValue(failed(status, body));
      return liftWorkflowMatureRestriction({ token: 't', workflowId: 'w1' });
    },
    () => ({ outcome: 'insufficient-funds' }),
  ],
  [
    'getConsumerBlobUploadUrlService',
    (status, body) => {
      vi.mocked(getConsumerBlobUploadUrl).mockResolvedValue(failed(status, body));
      return getConsumerBlobUploadUrlService({ token: 't' });
    },
    (message) => ({ code: 'UNAUTHORIZED', message }),
  ],
];

describe.each(sites)('%s', (_, call, unmatched403) => {
  beforeEach(() => BUZZ_LIMIT_REFUSALS.push(...FIXTURE));
  afterEach(() => BUZZ_LIMIT_REFUSALS.splice(0));

  it("maps a personal key's over-limit 403 to FORBIDDEN naming the key's limit", async () => {
    expect(await caught(call(403, OVER_LIMIT))).toMatchObject({
      code: 'FORBIDDEN',
      message: API_KEY_BUZZ_LIMIT_REACHED,
    });
  });

  it("maps an app's over-limit 429 to FORBIDDEN naming the app's limit, not a retryable 429", async () => {
    expect(await caught(call(429, OAUTH_OVER_LIMIT))).toMatchObject({
      code: 'FORBIDDEN',
      message: OFFLINE_BUZZ_CAP_REACHED,
    });
  });

  it('leaves a real insufficient-funds 403 as it was', async () => {
    const result = await call(403, NO_FUNDS).catch((e: unknown) => e);
    expect(result).toStrictEqual(expect.objectContaining(unmatched403(NO_FUNDS.detail) as object));
  });

  it('leaves a scope 403 as it was', async () => {
    const result = await call(403, SCOPE).catch((e: unknown) => e);
    expect(result).toStrictEqual(expect.objectContaining(unmatched403(SCOPE.detail) as object));
  });
});
