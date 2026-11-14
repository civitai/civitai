import type { NextApiRequest, NextApiResponse } from 'next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redisMock } from '~/__tests__/mocks';
import type * as OrchestrationClient from '@civitai/orchestration-client';

const { mockRefreshBlob, mockQueryWorkflows } = vi.hoisted(() => ({
  mockRefreshBlob: vi.fn(),
  mockQueryWorkflows: vi.fn(),
}));

vi.mock('@civitai/orchestration-client', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestrationClient>()),
  refreshBlob: mockRefreshBlob,
}));
vi.mock('~/server/services/orchestrator/client', () => ({
  createOrchestratorClient: () => ({}),
}));
vi.mock('~/server/services/orchestrator/workflows', () => ({
  queryWorkflows: mockQueryWorkflows,
}));
vi.mock('~/server/utils/endpoint-helpers', () => ({
  OrchestratorEndpoint:
    (handler: (...args: unknown[]) => unknown) => (req: NextApiRequest, res: NextApiResponse) =>
      handler(req, res, (req as unknown as { user: unknown }).user, 'caller-token'),
}));

import handler from '~/pages/api/orchestrator/refreshBlobs';

const CALLER = 7;
const OTHER = 8;
const DAY = 24 * 60 * 60 * 1000;

const blob = (id: string) => ({ id, available: true, url: `https://o/v2/consumer/blobs/${id}` });

type Fixture = {
  owner: number;
  outputs?: string[];
  inputs?: string[];
  ageDays?: number;
  steps?: Record<string, unknown>[];
};
const workflow = ({ owner, outputs = [], inputs = [], ageDays = 1, steps }: Fixture) => ({
  id: `${owner}-${Date.now() - ageDays * DAY}`,
  createdAt: new Date(Date.now() - ageDays * DAY).toISOString(),
  steps: steps ?? [
    {
      $type: 'imageGen',
      input: { images: inputs.map(blob) },
      output: { images: outputs.map(blob) },
    },
  ],
});
const page = (items: ReturnType<typeof workflow>[], nextCursor?: string) => ({ items, nextCursor });

async function call(blobIds: string[], user = { id: CALLER, isModerator: false }) {
  let body: unknown;
  let status = 0;
  const res = {
    status: (code: number) => {
      status = code;
      return res;
    },
    json: (payload: unknown) => {
      body = payload;
      return res;
    },
  } as unknown as NextApiResponse;
  await handler({ method: 'POST', body: { blobIds }, user } as unknown as NextApiRequest, res);
  const results = (body as { results: { blobId: string; status: string }[] }).results;
  return { status, byId: Object.fromEntries(results.map((r) => [r.blobId, r.status])) };
}

const refreshedIds = () =>
  mockRefreshBlob.mock.calls.map(
    ([options]) => (options as { path: { blobId: string } }).path.blobId
  );

beforeEach(() => {
  mockRefreshBlob.mockReset();
  mockQueryWorkflows.mockReset();
  mockRefreshBlob.mockImplementation(async ({ path }: { path: { blobId: string } }) => ({
    data: { id: path.blobId, available: true, url: `https://o/${path.blobId}?sig=fresh` },
    response: { status: 200 },
  }));
  const store = new Map<string, unknown>();
  redisMock.redis.packed.get.mockImplementation(async (key: string) => store.get(key) ?? null);
  redisMock.redis.packed.set.mockImplementation(async (key: string, value: unknown) => {
    store.set(key, structuredClone(value));
  });
});

describe('refreshBlobs re-signs only the caller’s own blobs', () => {
  it('denies an id that is not an output of the caller’s workflows, without refreshing it', async () => {
    mockQueryWorkflows.mockResolvedValue(
      page([workflow({ owner: CALLER, outputs: ['MINE.jpeg'] })])
    );

    const { status, byId } = await call(['THEIRS.jpeg']);

    expect(status).toBe(200);
    expect(byId).toEqual({ 'THEIRS.jpeg': 'denied' });
    expect(mockRefreshBlob).not.toHaveBeenCalled();
  });

  it('refreshes an output of the caller’s own workflow', async () => {
    mockQueryWorkflows.mockResolvedValue(
      page([workflow({ owner: CALLER, outputs: ['MINE.jpeg'] })])
    );

    expect((await call(['MINE.jpeg'])).byId).toEqual({ 'MINE.jpeg': 'refreshed' });
    expect(refreshedIds()).toEqual(['MINE.jpeg']);
  });

  it('does not count a blob the caller only named as an input', async () => {
    mockQueryWorkflows.mockResolvedValue(
      page([workflow({ owner: CALLER, inputs: ['THEIRS.jpeg'] })])
    );

    expect((await call(['THEIRS.jpeg'])).byId).toEqual({ 'THEIRS.jpeg': 'denied' });
    expect(mockRefreshBlob).not.toHaveBeenCalled();
  });

  it('does not count a listed workflow whose id names another owner', async () => {
    mockQueryWorkflows.mockResolvedValue(
      page([workflow({ owner: OTHER, outputs: ['THEIRS.jpeg'] })])
    );

    expect((await call(['THEIRS.jpeg'])).byId).toEqual({ 'THEIRS.jpeg': 'denied' });
    expect(mockRefreshBlob).not.toHaveBeenCalled();
  });

  it.each([
    ['merge', { $type: 'merge', output: { fields: { x: [blob('THEIRS.jpeg')] } } }],
    [
      'repeat',
      {
        $type: 'repeat',
        output: {
          steps: [{ $type: 'imageGen', input: { images: [blob('THEIRS.jpeg')] }, output: {} }],
        },
      },
    ],
    ['echo', { $type: 'echo', output: { images: [blob('THEIRS.jpeg')] } }],
    [
      'metadata',
      { $type: 'imageGen', output: { images: [] }, metadata: { x: blob('THEIRS.jpeg') } },
    ],
  ])('does not count a blob a %s step carries through', async (_, step) => {
    mockQueryWorkflows.mockResolvedValue(page([workflow({ owner: CALLER, steps: [step] })]));

    expect((await call(['THEIRS.jpeg'])).byId).toEqual({ 'THEIRS.jpeg': 'denied' });
    expect(mockRefreshBlob).not.toHaveBeenCalled();
  });

  it('refreshes a video the caller generated', async () => {
    mockQueryWorkflows.mockResolvedValue(
      page([
        workflow({
          owner: CALLER,
          steps: [{ $type: 'videoGen', output: { video: blob('V.mp4') } }],
        }),
      ])
    );

    expect((await call(['V.mp4'])).byId).toEqual({ 'V.mp4': 'refreshed' });
  });

  it('answers a repeat request from the cached scan without rescanning', async () => {
    mockQueryWorkflows.mockResolvedValue(page([], 'deeper'));
    await call(['DEEP.jpeg']);
    mockQueryWorkflows.mockClear();

    expect((await call(['DEEP.jpeg'])).byId).toEqual({ 'DEEP.jpeg': 'denied' });
    expect(mockQueryWorkflows).not.toHaveBeenCalled();
  });

  it('denies an output of a workflow older than 30 days', async () => {
    mockQueryWorkflows.mockResolvedValue(
      page([workflow({ owner: CALLER, outputs: ['OLD.jpeg'], ageDays: 31 })])
    );

    expect((await call(['OLD.jpeg'])).byId).toEqual({ 'OLD.jpeg': 'denied' });
    expect(mockRefreshBlob).not.toHaveBeenCalled();
    const { fromDate } = mockQueryWorkflows.mock.calls[0][0] as { fromDate: Date };
    expect(Math.abs(Date.now() - 30 * DAY - fromDate.getTime())).toBeLessThan(60_000);
  });

  it('denies, and refreshes nothing, when the ownership lookup fails', async () => {
    mockQueryWorkflows.mockRejectedValue(new Error('orchestrator down'));

    expect((await call(['MINE.jpeg'])).byId).toEqual({ 'MINE.jpeg': 'denied' });
    expect(mockRefreshBlob).not.toHaveBeenCalled();
  });

  it('denies what the page cap leaves unproven, without refreshing it', async () => {
    // Throws past the cap so a broken cap fails the count below instead of looping forever.
    mockQueryWorkflows.mockImplementation(async () => {
      if (mockQueryWorkflows.mock.calls.length > 20) throw new Error('scan did not stop');
      return page([workflow({ owner: CALLER, outputs: ['A.jpeg'] })], 'more');
    });

    expect((await call(['DEEP.jpeg'])).byId).toEqual({ 'DEEP.jpeg': 'denied' });
    expect(mockQueryWorkflows).toHaveBeenCalledTimes(5);
    expect(mockRefreshBlob).not.toHaveBeenCalled();
  });

  it('lets a moderator refresh another user’s blob', async () => {
    const moderator = { id: OTHER, isModerator: true };

    expect((await call(['THEIRS.jpeg'], moderator)).byId).toEqual({ 'THEIRS.jpeg': 'refreshed' });
    expect(refreshedIds()).toEqual(['THEIRS.jpeg']);
  });

  it('answers a mixed batch per id', async () => {
    mockQueryWorkflows
      .mockResolvedValueOnce(page([workflow({ owner: CALLER, outputs: ['MINE1.jpeg'] })], 'p2'))
      .mockResolvedValueOnce(page([workflow({ owner: CALLER, outputs: ['MINE2.jpeg'] })]));

    const { byId } = await call(['MINE1.jpeg', 'THEIRS.jpeg', 'MINE2.jpeg']);

    expect(byId).toEqual({
      'MINE1.jpeg': 'refreshed',
      'THEIRS.jpeg': 'denied',
      'MINE2.jpeg': 'refreshed',
    });
    expect(refreshedIds().sort()).toEqual(['MINE1.jpeg', 'MINE2.jpeg']);
  });

  it('does not let one user’s cached scan prove a blob for another', async () => {
    mockQueryWorkflows.mockResolvedValueOnce(
      page([workflow({ owner: OTHER, outputs: ['THEIRS.jpeg'] })])
    );
    await call(['THEIRS.jpeg'], { id: OTHER, isModerator: false });
    mockRefreshBlob.mockClear();
    mockQueryWorkflows.mockResolvedValue(page([]));

    expect((await call(['THEIRS.jpeg'])).byId).toEqual({ 'THEIRS.jpeg': 'denied' });
    expect(mockRefreshBlob).not.toHaveBeenCalled();
  });
});
