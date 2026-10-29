import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OrchestrationNew from '~/server/services/orchestrator/orchestration-new.service';
import type * as ImageService from '~/server/services/image.service';
import type * as S3Utils from '~/utils/s3-utils';
import type * as StorageResolver from '~/server/services/storage-resolver';

const mocks = vi.hoisted(() => ({
  getWorkflow: vi.fn(),
  createImage: vi.fn(async (..._a: unknown[]) => ({ id: 900 })),
  s3Send: vi.fn(async (..._a: unknown[]) => undefined),
}));

vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: async () => 'token',
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({ getWorkflow: mocks.getWorkflow }));
// The real formatter, spied: a hand-built normalized fixture could disagree with what it produces.
vi.mock('~/server/services/orchestrator/orchestration-new.service', async (importOriginal) => {
  const actual = await importOriginal<typeof OrchestrationNew>();
  return { ...actual, formatGenerationResponse2: vi.fn(actual.formatGenerationResponse2) };
});
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  createImage: mocks.createImage,
}));
vi.mock('~/utils/s3-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof S3Utils>()),
  getImageUploadBackend: async () => ({
    s3: { send: mocks.s3Send },
    bucket: 'bucket',
    backend: 'test',
  }),
}));
vi.mock('~/server/services/storage-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof StorageResolver>()),
  registerMediaLocation: vi.fn(),
}));

import { redisMock } from '~/__tests__/mocks/redis.mock';
import { pollIterationWorkflow } from '~/server/services/orchestrator/poll-iteration';
import { formatGenerationResponse2 } from '~/server/services/orchestrator/orchestration-new.service';
import { isMature } from '~/shared/constants/orchestrator.constants';
import { orchestratorNsfwLevelMap } from '~/shared/constants/browsingLevel.constants';
import { UNMARKED_SOURCE_IMAGE_MESSAGE } from '~/shared/constants/mature-source.constants';

const MATURE = 'x';
const SAFE = 'pg';

const output = (over: Record<string, unknown> = {}) => ({
  id: 'b1',
  url: 'https://orchestrator.test/b1.jpeg',
  available: true,
  ...over,
});

// The raw shape iteration workflows have in production: an imageGen step with `output.images`.
function givenWorkflow(
  outputs: Array<Record<string, unknown>>,
  {
    allowMatureContent = false,
    status = 'succeeded',
  }: { allowMatureContent?: boolean; status?: string } = {}
) {
  mocks.getWorkflow.mockResolvedValue({
    id: 'wf-1',
    status,
    allowMatureContent,
    steps: [{ $type: 'imageGen', name: '$0', status, metadata: {}, output: { images: outputs } }],
  });
}

const poll = ({ domain = 'red', showNsfw = true }: { domain?: string; showNsfw?: boolean } = {}) =>
  pollIterationWorkflow({
    workflowId: 'wf-1',
    width: 512,
    height: 512,
    prompt: 'p',
    userId: 7,
    ctx: { domain, user: { id: 7, showNsfw } },
  });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
  );
});

describe('pollIterationWorkflow availability', () => {
  it('has a fixture level the mature check recognises', () => {
    expect(isMature(MATURE as never)).toBeTruthy();
    expect(isMature(SAFE as never)).toBeFalsy();
  });

  it('returns a rated, unrestricted result', async () => {
    givenWorkflow([output({ nsfwLevel: SAFE })]);

    const result = await poll();

    expect(result.status).toBe('succeeded');
    expect(result.images).toEqual([
      { url: expect.any(String), id: 900, nsfwLevel: orchestratorNsfwLevelMap[SAFE] },
    ]);
    expect(orchestratorNsfwLevelMap[SAFE]).toEqual(expect.any(Number));
    expect(mocks.createImage).toHaveBeenCalledTimes(1);
    expect(formatGenerationResponse2).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('records the stored key as issued to the polling user', async () => {
    givenWorkflow([output({ nsfwLevel: SAFE })]);

    await poll();

    const key = (mocks.createImage.mock.calls[0][0] as { url: string }).url;
    expect(key).toEqual(expect.any(String));
    expect(redisMock.sysRedis.set).toHaveBeenCalledExactlyOnceWith(
      `system:upload-key-owner:${key}`,
      '7',
      { EX: 30 * 24 * 60 * 60 }
    );
  });

  it('formats nothing while the workflow is still running', async () => {
    givenWorkflow([], { status: 'processing' });

    const result = await poll();

    expect(result.status).toBe('processing');
    expect(formatGenerationResponse2).not.toHaveBeenCalled();
  });

  it('withholds a mature result that still needs unlocking', async () => {
    givenWorkflow([output({ nsfwLevel: MATURE })]);

    const result = await poll();

    expect(result.status).toBe('failed');
    expect(result.errorMessage).toMatch(/yellow Buzz/);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.createImage).not.toHaveBeenCalled();
  });

  it('tells a user held to PG-13 by their source image how to bring a Civitai image in', async () => {
    givenWorkflow([output({ available: false, blockedReason: 'NSFWLevelSourceImageRestricted' })], {
      status: 'failed',
    });

    const result = await poll();

    expect(result.status).toBe('failed');
    expect(result.errorMessage).toBe(UNMARKED_SOURCE_IMAGE_MESSAGE);
  });

  it('hands a mature result off instead of returning it on the restricted site', async () => {
    givenWorkflow([output({ nsfwLevel: MATURE })], { allowMatureContent: true });

    const result = await poll({ domain: 'green' });

    expect(result).toMatchObject({ status: 'siteRestricted', workflowId: 'wf-1', images: [] });
    expect(mocks.createImage).not.toHaveBeenCalled();
  });

  it('withholds a mature result from a user with mature content turned off', async () => {
    givenWorkflow([output({ nsfwLevel: MATURE })], { allowMatureContent: true });

    const result = await poll({ showNsfw: false });

    expect(result.status).toBe('failed');
    expect(result.errorMessage).toMatch(/settings/i);
    expect(mocks.createImage).not.toHaveBeenCalled();
  });

  it('keeps polling while a finished result has not been rated', async () => {
    givenWorkflow([output()]);

    const result = await poll();

    expect(result.status).toBe('processing');
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.createImage).not.toHaveBeenCalled();
  });

  it('returns only the results that may be shown', async () => {
    givenWorkflow([
      output({ id: 'safe', url: 'https://orchestrator.test/safe.jpeg', nsfwLevel: SAFE }),
      output({ id: 'mature', url: 'https://orchestrator.test/mature.jpeg', nsfwLevel: MATURE }),
    ]);

    const result = await poll();

    expect(result.status).toBe('succeeded');
    expect(result.images).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('https://orchestrator.test/safe.jpeg');
  });

  it('returns the shown results rather than handing off when only some are restricted', async () => {
    givenWorkflow(
      [
        output({ id: 'safe', url: 'https://orchestrator.test/safe.jpeg', nsfwLevel: SAFE }),
        output({ id: 'mature', url: 'https://orchestrator.test/mature.jpeg', nsfwLevel: MATURE }),
      ],
      { allowMatureContent: true }
    );

    const result = await poll({ domain: 'green' });

    expect(result.status).toBe('succeeded');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('https://orchestrator.test/safe.jpeg');
  });
});
