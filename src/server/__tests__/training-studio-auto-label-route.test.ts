import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as EndpointHelpers from '~/server/utils/endpoint-helpers';
import type * as TrainingService from '~/server/services/training.service';
import type * as StudioAccess from '~/server/utils/training-studio-access';
import type * as StudioLimit from '~/server/utils/training-studio-auto-label-rate-limit';
import type { SessionUser } from '~/types/session';

/**
 * The Studio's auto-label route bills the system account, and its gate and rate limit are the only
 * bounds on that spend: nothing may be submitted unless both pass.
 */

vi.mock('~/server/utils/endpoint-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof EndpointHelpers>()),
  AuthedEndpoint: (handler: unknown) => handler,
}));
vi.mock('~/server/utils/training-studio-access', async (importOriginal) => ({
  ...(await importOriginal<typeof StudioAccess>()),
  allowStudioAutoLabel: vi.fn(),
}));
vi.mock('~/server/utils/training-studio-auto-label-rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof StudioLimit>()),
  checkStudioAutoLabelRateLimit: vi.fn(),
}));
vi.mock('~/server/services/training.service', async (importOriginal) => ({
  ...(await importOriginal<typeof TrainingService>()),
  submitStudioAutoLabelWorkflow: vi.fn(async () => ({ workflowId: 'wf', stepCount: 1 })),
}));

const { allowStudioAutoLabel } = await import('~/server/utils/training-studio-access');
const { checkStudioAutoLabelRateLimit } = await import(
  '~/server/utils/training-studio-auto-label-rate-limit'
);
const { submitStudioAutoLabelWorkflow } = await import('~/server/services/training.service');
const handler = (await import('~/pages/api/training-studio/auto-label')).default as unknown as (
  req: NextApiRequest,
  res: NextApiResponse,
  user: SessionUser
) => Promise<void>;

const validBody = {
  mediaType: 'image',
  images: [{ mediaUrl: 'https://x/a.png', filename: 'k0' }],
  params: { type: 'caption', temperature: 0.7, maxNewTokens: 300 },
};

async function post(body: unknown) {
  let status = 200;
  const res = {
    status: vi.fn((s: number) => ((status = s), res)),
    json: vi.fn(() => res),
    setHeader: vi.fn(),
  };
  await handler({ method: 'POST', body } as never, res as never, { id: 42 } as SessionUser);
  return status;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(allowStudioAutoLabel).mockResolvedValue(true);
  vi.mocked(checkStudioAutoLabelRateLimit).mockResolvedValue({ allowed: true });
});

describe('POST /api/training-studio/auto-label', () => {
  it('submits a valid batch for the caller', async () => {
    expect(await post(validBody)).toBe(200);
    expect(submitStudioAutoLabelWorkflow).toHaveBeenCalledTimes(1);
    expect(submitStudioAutoLabelWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 42 })
    );
  });

  it('submits nothing when the gate refuses', async () => {
    vi.mocked(allowStudioAutoLabel).mockResolvedValue(false);
    await post(validBody);
    expect(checkStudioAutoLabelRateLimit).not.toHaveBeenCalled();
    expect(submitStudioAutoLabelWorkflow).not.toHaveBeenCalled();
  });

  it('submits nothing over the rate limit', async () => {
    vi.mocked(checkStudioAutoLabelRateLimit).mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 30,
    });
    expect(await post(validBody)).toBe(429);
    expect(submitStudioAutoLabelWorkflow).not.toHaveBeenCalled();
  });

  it('refuses an invalid body without counting it', async () => {
    expect(await post({ ...validBody, images: [] })).toBe(400);
    expect(checkStudioAutoLabelRateLimit).not.toHaveBeenCalled();
    expect(submitStudioAutoLabelWorkflow).not.toHaveBeenCalled();
  });
});
