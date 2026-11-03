import { createHash } from 'crypto';
import type { Readable } from 'stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CsamService from '~/server/services/csam.service';
import type * as FlaggedConsumers from '~/server/http/orchestrator/flagged-consumers';
import type * as UserService from '~/server/services/user.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

/** Preserving a user's generator evidence and filing it. Every id, host and byte below is invented. */

const { createCsamReport, reviewConsumerStrikes, softDeleteUser } = vi.hoisted(() => ({
  createCsamReport: vi.fn(),
  reviewConsumerStrikes: vi.fn(),
  softDeleteUser: vi.fn(),
}));

vi.mock('~/server/services/csam.service', async (importOriginal) => ({
  ...(await importOriginal<typeof CsamService>()),
  createCsamReport,
}));
vi.mock('~/server/http/orchestrator/flagged-consumers', async (importOriginal) => ({
  ...(await importOriginal<typeof FlaggedConsumers>()),
  reviewConsumerStrikes,
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  softDeleteUser,
}));

import { preserveGeneratorEvidence } from '~/server/services/generator-evidence/generator-evidence.service';
import type { EvidenceStore } from '~/server/services/generator-evidence/preserve-blob';

const config = {
  base: 'https://orchestrator.example.invalid',
  origin: 'https://orchestrator.example.invalid',
  token: 'test-token',
};
const USER = 7;
const WORKFLOW = `${USER}-20261101000000000000`;
const INPUT = 'INPUT0000000001.jpeg';
const OUTPUT = 'OUTPUT000000001.png';
const bytes = Buffer.from('original bytes');

const workflow = {
  id: WORKFLOW,
  createdAt: '2026-11-01T00:00:00Z',
  steps: [
    {
      name: 'edit',
      $type: 'imageGen',
      input: {
        prompt: 'a prompt',
        images: [`${config.base}/v2/consumer/blobs/${INPUT}?sig=x`],
      },
      output: { images: [{ type: 'image', id: OUTPUT, available: true }] },
    },
  ],
};

function memoryStore(): EvidenceStore {
  const objects = new Map<string, Buffer>();
  return {
    upload: vi.fn(async (key: string, body: Readable) => {
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
      objects.set(key, Buffer.concat(chunks));
    }),
    head: async (key) => (objects.has(key) ? { bytes: objects.get(key)!.length } : null),
    sha256: async (key) =>
      createHash('sha256')
        .update(objects.get(key) ?? Buffer.alloc(0))
        .digest('hex'),
  };
}

const fetched: string[] = [];
beforeEach(() => {
  fetched.length = 0;
  createCsamReport.mockReset().mockResolvedValue({ id: 55 });
  reviewConsumerStrikes.mockReset();
  softDeleteUser.mockReset();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input));
    fetched.push(url.pathname);
    if (url.pathname === `/v1/manager/workflows/${WORKFLOW}`)
      return new Response(JSON.stringify(workflow), { status: 200 });
    if (url.pathname.startsWith('/v2/consumer/blobs/content/'))
      return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } });
    if (url.pathname.startsWith('/v2/consumer/blobs/'))
      return new Response(null, {
        status: 308,
        headers: { location: '/v2/consumer/blobs/content/token' },
      });
    throw new Error(`unexpected fetch ${url}`);
  });
});

describe('preserveGeneratorEvidence', () => {
  it("refuses a workflow that is not the user's, and preserves nothing of it", async () => {
    const store = memoryStore();
    const other = `${USER + 1}-20261101000000000000`;

    const result = await preserveGeneratorEvidence(
      { userId: USER, moderatorId: 1, workflowIds: [other], triggers: [] },
      { config, store }
    );

    expect(result.reportId).toBeNull();
    expect(result.refused).toEqual([{ ref: other, reason: 'not a workflow of this user' }]);
    expect(fetched).toEqual([]);
    expect(store.upload).not.toHaveBeenCalled();
    expect(createCsamReport).not.toHaveBeenCalled();
  });

  it('files the preserved files as a report awaiting approval, with no strike or account action', async () => {
    const store = memoryStore();

    const result = await preserveGeneratorEvidence(
      { userId: USER, moderatorId: 1, workflowIds: [WORKFLOW], triggers: [], priorCTReports: [42] },
      { config, store }
    );

    expect(result).toMatchObject({ reportId: 55, counts: { preserved: 2 } });
    const filed = createCsamReport.mock.calls[0][0];
    expect(filed).toMatchObject({ userId: USER, reportedById: 1, type: 'GeneratedImage' });
    expect(filed.details.generatorEvidence).toEqual({ version: 1, priorCTReports: [42] });
    const blobs = filed.details.generatedImages[0].blobs;
    expect(blobs.map((b: { blobId: string; role: string }) => [b.blobId, b.role])).toEqual([
      [OUTPUT, 'output'],
      [INPUT, 'input'],
    ]);
    expect(blobs[1].derivedOutputIds).toEqual([OUTPUT]);
    expect(dbMock.dbWrite.evidenceHold.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: USER, role: 'manual', createdById: 1 }),
    });
    expect(reviewConsumerStrikes).not.toHaveBeenCalled();
    expect(softDeleteUser).not.toHaveBeenCalled();
  });

  it("preserves a trigger's input images by key and keeps its prompt, reading only this user's restriction", async () => {
    dbMock.dbRead.userRestriction.findMany.mockResolvedValue([
      {
        id: 31,
        triggers: [
          {
            prompt: 'trigger prompt',
            time: '2026-10-26T12:00:00Z',
            inputImages: [`https://cdn.example.invalid/v2/consumer/blobs/${INPUT}?sig=x`],
          },
        ],
      },
    ] as never);

    await preserveGeneratorEvidence(
      {
        userId: USER,
        moderatorId: 1,
        workflowIds: [],
        triggers: [{ restrictionId: 31, index: 0 }],
      },
      { config, store: memoryStore() }
    );

    expect(dbMock.dbRead.userRestriction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [31] }, userId: USER } })
    );
    const [job] = createCsamReport.mock.calls[0][0].details.generatedImages;
    expect(job).toMatchObject({ source: 'trigger', restrictionId: 31, prompt: 'trigger prompt' });
    expect(job.blobs).toEqual([
      expect.objectContaining({ blobId: INPUT, role: 'input', status: 'preserved' }),
    ]);
    expect(fetched).not.toContain(`/v2/consumer/blobs/${INPUT}?sig=x`);
  });

  it('keeps a withheld output by id without reading its bytes', async () => {
    const withheld = {
      ...workflow,
      steps: [
        {
          ...workflow.steps[0],
          output: { images: [{ id: OUTPUT, available: false, blockedReason: 'Csam' }] },
        },
      ],
    };
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = new URL(String(input));
      fetched.push(url.pathname);
      if (url.pathname.startsWith('/v1/manager/workflows/'))
        return new Response(JSON.stringify(withheld), { status: 200 });
      if (url.pathname === `/v2/consumer/blobs/${OUTPUT}`)
        return new Response(null, {
          status: 308,
          headers: { location: '/v2/consumer/blobs/blocked/token', 'x-blocked-reason': 'Csam' },
        });
      if (url.pathname.endsWith('/refresh')) return new Response('{}', { status: 200 });
      if (url.pathname.startsWith('/v2/consumer/blobs/content/'))
        return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } });
      return new Response(null, {
        status: 308,
        headers: { location: '/v2/consumer/blobs/content/token' },
      });
    });

    const result = await preserveGeneratorEvidence(
      { userId: USER, moderatorId: 1, workflowIds: [WORKFLOW], triggers: [] },
      { config, store: memoryStore() }
    );

    expect(result.counts).toEqual({ 'blocked-unreadable': 1, preserved: 1 });
    const [job] = createCsamReport.mock.calls[0][0].details.generatedImages;
    expect(job.blobs[0]).toMatchObject({ blobId: OUTPUT, status: 'blocked-unreadable' });
    expect(fetched.filter((p) => p.includes('/blocked/'))).toEqual([]);
  });
});
