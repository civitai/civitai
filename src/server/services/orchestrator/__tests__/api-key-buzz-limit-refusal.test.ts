import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The orchestrator answers a call that would spend past a key's Buzz limit with a 402 whose
 * ProblemDetails `detail` is `budgetExceeded`, the same for a personal key and an app's OAuth token.
 * Every site that maps an orchestrator failure turns it into a FORBIDDEN naming that limit, chosen by
 * the token the call was sent with. A real insufficient-funds 400 and a scope 403 keep their meaning.
 */

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
  submitWorkflow as clientSubmitWorkflow,
  updateWorkflow as clientUpdateWorkflow,
} from '@civitai/orchestration-client';
import {
  API_KEY_BUZZ_LIMIT_REACHED,
  OFFLINE_BUZZ_CAP_REACHED,
  isBuzzLimitRefusal,
} from '~/server/orchestrator/api-key-buzz-limit-refusal';
import { getConsumerBlobUploadUrlService } from '../consumerBlobUpload';
import {
  getWorkflow,
  liftWorkflowMatureRestriction,
  queryWorkflows,
  setWorkflowDownloadPriority,
  submitWorkflow,
} from '../workflows';

// The orchestrator's ProblemDetails replies.
const OVER_LIMIT = {
  type: 'https://tools.ietf.org/html/rfc9110#section-15.5.3',
  title: 'Payment Required',
  status: 402,
  detail: 'budgetExceeded',
};
const NO_FUNDS = {
  type: 'https://tools.ietf.org/html/rfc9110#section-15.5.1',
  title: 'Bad Request',
  status: 400,
  detail: 'insufficientBuzz',
};
const SCOPE = {
  type: 'https://tools.ietf.org/html/rfc9110#section-15.5.4',
  title: 'Insufficient token scope',
  status: 403,
  detail: 'This token does not have the required scope.',
  requiredScope: 'AIServicesWrite',
};

const PERSONAL_KEY = 'personal-key';
const OAUTH_TOKEN = 'civitai_app-token';

const failed = (body: { status: number }) =>
  ({
    data: undefined,
    error: body,
    response: { ok: false, status: body.status, headers: new Headers() },
  } as never);
const caught = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e
  );

beforeEach(() => vi.clearAllMocks());

describe('the matcher', () => {
  it('matches the over-limit reply, flat or nested under error', () => {
    expect(isBuzzLimitRefusal(402, OVER_LIMIT)).toBe(true);
    expect(isBuzzLimitRefusal(402, { error: OVER_LIMIT })).toBe(true);
  });

  it('needs both the status and the detail', () => {
    expect(isBuzzLimitRefusal(402, { ...OVER_LIMIT, detail: 'insufficientBuzz' })).toBe(false);
    expect(isBuzzLimitRefusal(400, OVER_LIMIT)).toBe(false);
    expect(isBuzzLimitRefusal(402, undefined)).toBe(false);
    expect(isBuzzLimitRefusal(undefined, OVER_LIMIT)).toBe(false);
  });
});

type Site = [
  string,
  (token: string, body: { status: number }) => Promise<unknown>,
  /** What this site gives for a failure that is not the over-limit reply, by status and detail. */
  (status: number, detail: string) => unknown
];
// Each maps a 403 to its insufficient-funds BAD_REQUEST, as on main.
const asBefore = (_status: number, message: string) => ({ code: 'BAD_REQUEST', message });
const submitBody = { steps: [] } as never;
const sites: Site[] = [
  [
    'submitWorkflow',
    (token, body) => {
      vi.mocked(clientSubmitWorkflow).mockResolvedValue(failed(body));
      return submitWorkflow({ token, body: submitBody });
    },
    asBefore,
  ],
  [
    'submitWorkflow (whatif)',
    (token, body) => {
      vi.mocked(clientSubmitWorkflow).mockResolvedValue(failed(body));
      return submitWorkflow({ token, body: submitBody, query: { whatif: true } });
    },
    asBefore,
  ],
  [
    'setWorkflowDownloadPriority (whatif)',
    (token, body) => {
      vi.mocked(clientUpdateWorkflow).mockResolvedValue(failed(body));
      return setWorkflowDownloadPriority({ token, workflowId: 'w1', whatif: true });
    },
    asBefore,
  ],
  [
    'queryWorkflows',
    (token, body) => {
      vi.mocked(clientQueryWorkflows).mockResolvedValue({ data: undefined, error: body } as never);
      return queryWorkflows({ token, hideMatureContent: false } as never);
    },
    asBefore,
  ],
  [
    'getWorkflow',
    (token, body) => {
      vi.mocked(clientGetWorkflow).mockResolvedValue({ data: undefined, error: body } as never);
      return getWorkflow({ token, path: { workflowId: 'w1' } });
    },
    asBefore,
  ],
  [
    'liftWorkflowMatureRestriction',
    (token, body) => {
      vi.mocked(clientUpdateWorkflow).mockResolvedValue(failed(body));
      return liftWorkflowMatureRestriction({ token, workflowId: 'w1' });
    },
    (status, message) =>
      status === 403 ? { outcome: 'insufficient-funds' } : { code: 'BAD_REQUEST', message },
  ],
  [
    'getConsumerBlobUploadUrlService',
    (token, body) => {
      vi.mocked(getConsumerBlobUploadUrl).mockResolvedValue(failed(body));
      return getConsumerBlobUploadUrlService({ token });
    },
    (status, message) =>
      status === 403 ? { code: 'UNAUTHORIZED', message } : { code: 'BAD_REQUEST', message },
  ],
];

describe.each(sites)('%s', (_, call, unmatched) => {
  it("maps a personal key's over-limit 402 to FORBIDDEN naming the key's limit", async () => {
    expect(await caught(call(PERSONAL_KEY, OVER_LIMIT))).toMatchObject({
      code: 'FORBIDDEN',
      message: API_KEY_BUZZ_LIMIT_REACHED,
    });
  });

  it("maps an app token's over-limit 402 to FORBIDDEN naming the app's limit", async () => {
    expect(await caught(call(OAUTH_TOKEN, OVER_LIMIT))).toMatchObject({
      code: 'FORBIDDEN',
      message: OFFLINE_BUZZ_CAP_REACHED,
    });
  });

  it.each([
    ['a real insufficient-funds 400', NO_FUNDS],
    ['a scope 403', SCOPE],
  ])('leaves %s as it was', async (__, body) => {
    const result = await call(PERSONAL_KEY, body).catch((e: unknown) => e);
    expect(result).toStrictEqual(
      expect.objectContaining(unmatched(body.status, body.detail) as object)
    );
  });
});
