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

import {
  approveGeneratorEvidenceReport,
  excludeGeneratorEvidenceFile,
  getGeneratorEvidenceReport,
  preserveGeneratorEvidence,
  recopyGeneratorEvidenceFile,
} from '~/server/services/generator-evidence/generator-evidence.service';
import type { EvidenceStore } from '~/server/services/generator-evidence/preserve-blob';
import { evidenceVersion } from '~/server/services/generator-evidence/evidence-meta';
import { MAX_EVIDENCE_FILES_PER_REPORT } from '~/server/services/generator-evidence/evidence-payload';
import { MAX_FILES_PER_PRESERVE, MAX_WORKFLOWS_PER_PRESERVE } from '~/server/schema/csam.schema';
import { MAX_MANIFEST_BYTES } from '~/server/services/generator-evidence/evidence-manifest';

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

function memoryStore(seed: Record<string, Buffer> = {}) {
  const objects = new Map<string, Buffer>(Object.entries(seed));
  const store: EvidenceStore = {
    read: async (key) => {
      const object = objects.get(key);
      if (!object) throw new Error('no such object');
      return new Uint8Array(object);
    },
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
  return store;
}

const fetched: string[] = [];
const fetchedUrls: string[] = [];
beforeEach(() => {
  fetched.length = 0;
  fetchedUrls.length = 0;
  createCsamReport.mockReset().mockResolvedValue({ id: 55 });
  reviewConsumerStrikes.mockReset();
  softDeleteUser.mockReset();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input));
    fetched.push(url.pathname);
    fetchedUrls.push(url.href);
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
    for (const write of [
      dbMock.dbWrite.user.update,
      dbMock.dbWrite.user.updateMany,
      dbMock.dbWrite.userRestriction.update,
      dbMock.dbWrite.userRestriction.updateMany,
      dbMock.dbWrite.$executeRaw,
    ])
      expect(write).not.toHaveBeenCalled();
  });

  it("preserves a trigger's input images by key and keeps its prompt, reading only this user's restriction", async () => {
    dbMock.dbRead.userRestriction.findMany.mockResolvedValue([
      {
        id: 31,
        triggers: [
          {
            prompt: 'trigger prompt',
            time: '2026-10-26T12:00:00Z',
            inputImages: [`https://orchestration.civitai.com/v2/consumer/blobs/${INPUT}?sig=x`],
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
    expect(fetchedUrls.filter((u) => u.includes('orchestration.civitai.com'))).toEqual([]);
  });

  it('keeps a withheld output by id without reading its bytes', async () => {
    const withheld = {
      ...workflow,
      steps: [
        {
          ...workflow.steps[0],
          output: { images: [{ id: OUTPUT, available: false, blockedReason: 'Withheld' }] },
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
          headers: { location: '/v2/consumer/blobs/blocked/token', 'x-blocked-reason': 'Withheld' },
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

  describe('the ids a filed report keeps for each file', () => {
    const JOB = 'a1b2c3d4-0000-4000-8000-000000000001';
    const serveWorkflowWith = (outputJobId: unknown) => {
      const served = vi.mocked(globalThis.fetch).getMockImplementation()!;
      const read = {
        ...workflow,
        steps: [
          {
            ...workflow.steps[0],
            output: {
              images: [{ type: 'image', id: OUTPUT, available: true, jobId: outputJobId }],
            },
          },
        ],
      };
      vi.mocked(globalThis.fetch).mockImplementation(async (input) =>
        new URL(String(input)).pathname === `/v1/manager/workflows/${WORKFLOW}`
          ? new Response(JSON.stringify(read), { status: 200 })
          : served(input)
      );
    };
    const filedBlob = (blobId: string) =>
      createCsamReport.mock.calls[0][0].details.generatedImages[0].blobs.find(
        (b: { blobId: string }) => b.blobId === blobId
      );

    it('keeps the workflow id on the entry and the producing job id on each output', async () => {
      serveWorkflowWith(JOB);

      await preserveGeneratorEvidence(
        { userId: USER, moderatorId: 1, workflowIds: [WORKFLOW], triggers: [] },
        { config, store: memoryStore() }
      );

      const [job] = createCsamReport.mock.calls[0][0].details.generatedImages;
      expect(job.workflowId).toBe(WORKFLOW);
      expect(filedBlob(OUTPUT)).toMatchObject({ status: 'preserved', orchestratorJobId: JOB });
    });

    it("does not carry another workflow's job id onto a file this workflow used as an input", async () => {
      dbMock.dbWrite.csamReport.findFirst.mockResolvedValueOnce({
        details: {
          generatorEvidence: { version: 1 },
          generatedImages: [
            {
              jobId: `${USER}-20261031000000000000`,
              source: 'workflow',
              blobs: [
                {
                  blobId: INPUT,
                  role: 'output',
                  status: 'preserved',
                  evidenceKey: 'k',
                  orchestratorJobId: 'earlier-job',
                },
              ],
            },
          ],
        },
      } as never);

      await preserveGeneratorEvidence(
        { userId: USER, moderatorId: 1, workflowIds: [WORKFLOW], triggers: [] },
        { config, store: memoryStore() }
      );

      expect(filedBlob(INPUT)).toMatchObject({ role: 'input', evidenceKey: 'k' });
      expect(filedBlob(INPUT)).not.toHaveProperty('orchestratorJobId');
    });

    it('adds the job id to a file the pending report already holds', async () => {
      serveWorkflowWith(JOB);
      dbMock.dbWrite.csamReport.findFirst.mockResolvedValueOnce({
        details: {
          generatorEvidence: { version: 1 },
          generatedImages: [
            {
              jobId: WORKFLOW,
              source: 'workflow',
              blobs: [{ blobId: OUTPUT, role: 'output', status: 'preserved', evidenceKey: 'k' }],
            },
          ],
        },
      } as never);

      await preserveGeneratorEvidence(
        { userId: USER, moderatorId: 1, workflowIds: [WORKFLOW], triggers: [] },
        { config, store: memoryStore() }
      );

      expect(filedBlob(OUTPUT)).toMatchObject({ evidenceKey: 'k', orchestratorJobId: JOB });
    });

    it.each([
      ['has no job id', undefined],
      ['has a job id that is not an id', 'not an id/../x'],
      ['has a job id that is not a string', 12],
    ])('files an output whose read %s, without one', async (_, outputJobId) => {
      serveWorkflowWith(outputJobId);

      const result = await preserveGeneratorEvidence(
        { userId: USER, moderatorId: 1, workflowIds: [WORKFLOW], triggers: [] },
        { config, store: memoryStore() }
      );

      expect(result).toMatchObject({ reportId: 55, counts: { preserved: 2 } });
      expect(filedBlob(OUTPUT)).not.toHaveProperty('orchestratorJobId');
    });
  });

  describe('the file limit of one request', () => {
    beforeEach(() => dbMock.dbWrite.evidenceHold.create.mockClear());

    // One input plus `outputs` outputs.
    const serveWorkflowWith = (outputs: number) => {
      const images = Array.from({ length: outputs }, (_, i) => ({
        type: 'image',
        id: `OUTPUT${String(i).padStart(9, '0')}.png`,
        available: true,
      }));
      const big = { ...workflow, steps: [{ ...workflow.steps[0], output: { images } }] };
      const served = vi.mocked(globalThis.fetch).getMockImplementation()!;
      vi.mocked(globalThis.fetch).mockImplementation(async (input) =>
        new URL(String(input)).pathname === `/v1/manager/workflows/${WORKFLOW}`
          ? new Response(JSON.stringify(big), { status: 200 })
          : served(input)
      );
    };
    const restrictionWithOneInput = () =>
      dbMock.dbRead.userRestriction.findMany.mockResolvedValueOnce([
        {
          id: 31,
          triggers: [
            { inputImages: [`${config.base}/v2/consumer/blobs/TRIGGERIN0001.jpeg?sig=x`] },
          ],
        },
      ] as never);
    const nothingWritten = (store: EvidenceStore) => {
      expect(fetched.filter((path) => path.startsWith('/v2/consumer/blobs/'))).toEqual([]);
      expect(store.upload).not.toHaveBeenCalled();
      expect(dbMock.dbWrite.evidenceHold.create).not.toHaveBeenCalled();
      expect(createCsamReport).not.toHaveBeenCalled();
    };

    it('refuses a request over the limit before probing or copying any file', async () => {
      serveWorkflowWith(MAX_FILES_PER_PRESERVE);
      const store = memoryStore();

      await expect(
        preserveGeneratorEvidence(
          { userId: USER, moderatorId: 1, workflowIds: [WORKFLOW], triggers: [] },
          { config, store }
        )
      ).rejects.toThrow('This request covers 101 files; at most 100 can be preserved at once.');
      nothingWritten(store);
    });

    it("counts a trigger's inputs toward the limit", async () => {
      serveWorkflowWith(MAX_FILES_PER_PRESERVE - 1);
      restrictionWithOneInput();
      const store = memoryStore();

      await expect(
        preserveGeneratorEvidence(
          {
            userId: USER,
            moderatorId: 1,
            workflowIds: [WORKFLOW],
            triggers: [{ restrictionId: 31, index: 0 }],
          },
          { config, store }
        )
      ).rejects.toThrow(/covers 101 files/);
      nothingWritten(store);
    });

    it('preserves a request of exactly the limit', async () => {
      serveWorkflowWith(MAX_FILES_PER_PRESERVE - 2);
      restrictionWithOneInput();
      const store = memoryStore();

      const result = await preserveGeneratorEvidence(
        {
          userId: USER,
          moderatorId: 1,
          workflowIds: [WORKFLOW],
          triggers: [{ restrictionId: 31, index: 0 }],
        },
        { config, store }
      );

      expect(result.counts).toEqual({ preserved: MAX_FILES_PER_PRESERVE });
      expect(store.upload).toHaveBeenCalledTimes(MAX_FILES_PER_PRESERVE);
    });
  });

  describe('a file the pending report already holds', () => {
    const KEPT = `generator-evidence/${USER}/${USER}-20261031000000000000/${OUTPUT}`;
    const pendingWith = (blob: Record<string, unknown>) =>
      dbMock.dbWrite.csamReport.findFirst.mockResolvedValueOnce({
        details: {
          generatorEvidence: { version: 1 },
          generatedImages: [
            {
              jobId: `${USER}-20261031000000000000`,
              source: 'workflow',
              blobs: [{ blobId: OUTPUT, ...blob }],
            },
          ],
        },
      } as never);

    it('is not copied again, and takes the role this workflow gives it', async () => {
      pendingWith({
        role: 'input',
        status: 'preserved',
        evidenceKey: KEPT,
        sha256: 'a'.repeat(64),
        derivedOutputIds: ['SOMETHINGELSE.png'],
      });
      const store = memoryStore();

      await preserveGeneratorEvidence(
        { userId: USER, moderatorId: 1, workflowIds: [WORKFLOW], triggers: [] },
        { config, store }
      );

      const [job] = createCsamReport.mock.calls[0][0].details.generatedImages;
      const kept = job.blobs.find((b: { blobId: string }) => b.blobId === OUTPUT);
      expect(kept).toMatchObject({ role: 'output', evidenceKey: KEPT, stepName: 'edit' });
      expect(kept.derivedOutputIds).toBeUndefined();
      expect(vi.mocked(store.upload).mock.calls.map(([key]) => key)).not.toContainEqual(
        expect.stringContaining(OUTPUT)
      );
    });

    it('stays excluded when a later preserve names it again', async () => {
      const excluded = { reason: 'not relevant', byId: 2, at: '2026-11-02T00:00:00Z' };
      pendingWith({ role: 'output', status: 'excluded', evidenceKey: KEPT, excluded });

      await preserveGeneratorEvidence(
        { userId: USER, moderatorId: 1, workflowIds: [WORKFLOW], triggers: [] },
        { config, store: memoryStore() }
      );

      const [job] = createCsamReport.mock.calls[0][0].details.generatedImages;
      expect(job.blobs.find((b: { blobId: string }) => b.blobId === OUTPUT)).toMatchObject({
        status: 'excluded',
        excluded,
      });
    });
  });

  describe("adopting a preserve run's manifest", () => {
    const MANIFEST = `case-a/${USER}/manifest-20261103T000000Z.jsonl`;
    const COPY = `case-a/${USER}/${WORKFLOW}/${OUTPUT}`;
    const sha = createHash('sha256').update(bytes).digest('hex');
    const row = (over: Record<string, unknown> = {}) =>
      JSON.stringify({
        case: 'case-a',
        userId: USER,
        kind: 'output',
        imageId: OUTPUT,
        workflowId: WORKFLOW,
        status: 'copied',
        objectKey: COPY,
        sha256: sha,
        bytes: bytes.length,
        contentType: 'image/png',
        ...over,
      });

    it('adopts a copy that reads back as recorded instead of copying it again', async () => {
      const store = memoryStore({ [MANIFEST]: Buffer.from(row() + '\n'), [COPY]: bytes });

      await preserveGeneratorEvidence(
        { userId: USER, moderatorId: 1, workflowIds: [], triggers: [], manifestKey: MANIFEST },
        { config, store }
      );

      const blobs = createCsamReport.mock.calls[0][0].details.generatedImages[0].blobs;
      expect(blobs[0]).toMatchObject({ blobId: OUTPUT, status: 'preserved', evidenceKey: COPY });
      expect(store.upload).toHaveBeenCalledTimes(1);
      expect(vi.mocked(store.upload).mock.calls[0][0]).not.toBe(COPY);
    });

    it('copies afresh when the recorded copy no longer matches its sha256', async () => {
      const store = memoryStore({
        [MANIFEST]: Buffer.from(row() + '\n'),
        [COPY]: Buffer.from('other bytes!!!'),
      });

      await preserveGeneratorEvidence(
        { userId: USER, moderatorId: 1, workflowIds: [], triggers: [], manifestKey: MANIFEST },
        { config, store }
      );

      const blobs = createCsamReport.mock.calls[0][0].details.generatedImages[0].blobs;
      expect(blobs[0].evidenceKey).not.toBe(COPY);
      expect(blobs[0].status).toBe('preserved');
    });

    it("ignores a row whose copy sits outside the manifest's folder", async () => {
      const outside = `case-a/${USER + 1}/${WORKFLOW}/${OUTPUT}`;
      const store = memoryStore({
        [MANIFEST]: Buffer.from(row({ objectKey: outside }) + '\n'),
        [outside]: bytes,
      });

      await preserveGeneratorEvidence(
        { userId: USER, moderatorId: 1, workflowIds: [], triggers: [], manifestKey: MANIFEST },
        { config, store }
      );

      const blobs = createCsamReport.mock.calls[0][0].details.generatedImages[0].blobs;
      expect(blobs[0].evidenceKey).not.toBe(outside);
    });

    it('copies afresh when the manifest records a type that is not evidence media', async () => {
      const store = memoryStore({
        [MANIFEST]: Buffer.from(row({ contentType: 'text/html' }) + '\n'),
        [COPY]: bytes,
      });

      await preserveGeneratorEvidence(
        { userId: USER, moderatorId: 1, workflowIds: [], triggers: [], manifestKey: MANIFEST },
        { config, store }
      );

      const blobs = createCsamReport.mock.calls[0][0].details.generatedImages[0].blobs;
      expect(blobs[0]).toMatchObject({ status: 'preserved', contentType: 'image/png' });
      expect(blobs[0].evidenceKey).not.toBe(COPY);
    });

    it("refuses a request over the workflow limit, counting the manifest's, before reading any", async () => {
      const posted = Array.from(
        { length: MAX_WORKFLOWS_PER_PRESERVE },
        (_, i) => `${USER}-202611010000000000${String(i + 1).padStart(2, '0')}`
      );
      const store = memoryStore({ [MANIFEST]: Buffer.from(row() + '\n'), [COPY]: bytes });

      await expect(
        preserveGeneratorEvidence(
          {
            userId: USER,
            moderatorId: 1,
            workflowIds: posted,
            triggers: [],
            manifestKey: MANIFEST,
          },
          { config, store }
        )
      ).rejects.toThrow(/at most 10 can be preserved at once/);
      expect(fetched).toEqual([]);
      expect(store.upload).not.toHaveBeenCalled();
      expect(createCsamReport).not.toHaveBeenCalled();
    });

    it("refuses another user's manifest without reading the store", async () => {
      const other = `case-a/${USER + 1}/manifest-20261103T000000Z.jsonl`;
      const store = memoryStore({ [other]: Buffer.from(row({ userId: USER + 1 }) + '\n') });
      const read = vi.spyOn(store, 'read');
      const head = vi.spyOn(store, 'head');

      await expect(
        preserveGeneratorEvidence(
          { userId: USER, moderatorId: 1, workflowIds: [], triggers: [], manifestKey: other },
          { config, store }
        )
      ).rejects.toThrow(/not one of this user/);
      expect(read).not.toHaveBeenCalled();
      expect(head).not.toHaveBeenCalled();
      expect(createCsamReport).not.toHaveBeenCalled();
    });

    it('refuses a manifest that grew past the size cap after its HEAD, reading at most the cap', async () => {
      const store = memoryStore({ [MANIFEST]: Buffer.alloc(MAX_MANIFEST_BYTES + 1, ' ') });
      vi.spyOn(store, 'head').mockResolvedValue({ bytes: 10 });
      const read = vi.spyOn(store, 'read');

      await expect(
        preserveGeneratorEvidence(
          { userId: USER, moderatorId: 1, workflowIds: [], triggers: [], manifestKey: MANIFEST },
          { config, store }
        )
      ).rejects.toThrow(/manifest is over/);
      expect(read).toHaveBeenCalledWith(MANIFEST, MAX_MANIFEST_BYTES);
      expect(createCsamReport).not.toHaveBeenCalled();
    });

    it('refuses a manifest over the size cap without reading it', async () => {
      const store = memoryStore({
        [MANIFEST]: Buffer.alloc(MAX_MANIFEST_BYTES + 1, ' '),
      });
      const read = vi.spyOn(store, 'read');

      await expect(
        preserveGeneratorEvidence(
          { userId: USER, moderatorId: 1, workflowIds: [], triggers: [], manifestKey: MANIFEST },
          { config, store }
        )
      ).rejects.toThrow(/manifest is over/);
      expect(read).not.toHaveBeenCalled();
      expect(createCsamReport).not.toHaveBeenCalled();
    });
  });

  describe('approving a report', () => {
    const preservedDetails = {
      generatorEvidence: { version: 1 },
      generatedImages: [
        { jobId: WORKFLOW, blobs: [{ blobId: OUTPUT, role: 'output', status: 'preserved' }] },
      ],
    };

    it('refuses a report with no preserved file', async () => {
      const nothingPreserved = {
        ...preservedDetails,
        generatedImages: [{ jobId: WORKFLOW, blobs: [{ blobId: OUTPUT, status: 'gone' }] }],
      };
      dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([{ details: nothingPreserved }] as never);
      await expect(
        approveGeneratorEvidenceReport({
          reportId: 3,
          userId: USER,
          moderatorId: 1,
          version: evidenceVersion(nothingPreserved as never),
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(dbMock.dbWrite.csamReport.update).not.toHaveBeenCalled();
    });

    it('refuses an approval of the report as it was before files were added', async () => {
      const seen = evidenceVersion(preservedDetails as never);
      const grown = {
        ...preservedDetails,
        generatedImages: [
          ...preservedDetails.generatedImages,
          { jobId: 'later', blobs: [{ blobId: 'LATER', role: 'output', status: 'preserved' }] },
        ],
      };
      dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([{ details: grown }] as never);
      await expect(
        approveGeneratorEvidenceReport({ reportId: 3, userId: USER, moderatorId: 1, version: seen })
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(dbMock.dbWrite.csamReport.update).not.toHaveBeenCalled();
    });

    it('a report over the file limit says so on the review page and cannot be approved', async () => {
      const tooMany = {
        ...preservedDetails,
        generatedImages: [
          {
            jobId: WORKFLOW,
            blobs: Array.from({ length: MAX_EVIDENCE_FILES_PER_REPORT + 1 }, (_, i) => ({
              blobId: `B${i}`,
              role: 'output',
              status: 'preserved',
            })),
          },
        ],
      };
      dbMock.dbWrite.csamReport.findFirst.mockResolvedValueOnce({
        id: 3,
        createdAt: new Date(),
        reportedById: 1,
        details: tooMany,
      } as never);
      dbMock.dbWrite.modActivity.findMany.mockResolvedValueOnce([] as never);
      const page = await getGeneratorEvidenceReport(USER, 1);
      expect(page?.sendProblem).toMatch(
        /holds 1,001 files to send; one report can send at most 1,000/
      );

      dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([{ details: tooMany }] as never);
      await expect(
        approveGeneratorEvidenceReport({
          reportId: 3,
          userId: USER,
          moderatorId: 1,
          version: evidenceVersion(tooMany as never),
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: page?.sendProblem });
      expect(dbMock.dbWrite.csamReport.update).not.toHaveBeenCalled();
    });

    it('records who approved it, and when', async () => {
      dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([{ details: preservedDetails }] as never);
      const before = Date.now();
      await approveGeneratorEvidenceReport({
        reportId: 3,
        userId: USER,
        moderatorId: 1,
        version: evidenceVersion(preservedDetails as never),
      });
      const { where, data } = dbMock.dbWrite.csamReport.update.mock.calls[0][0] as {
        where: unknown;
        data: { details: { generatorEvidence: { approvedAt: string; approvedById: number } } };
      };
      expect(where).toEqual({ id: 3 });
      expect(data.details.generatorEvidence.approvedById).toBe(1);
      const approvedAt = Date.parse(data.details.generatorEvidence.approvedAt);
      expect(approvedAt).toBeGreaterThanOrEqual(before);
      expect(approvedAt).toBeLessThanOrEqual(Date.now());
    });
  });

  describe('changing one file of an unsent report', () => {
    const OLD_KEY = `generator-evidence/${USER}/${WORKFLOW}/${OUTPUT}`;
    const report = () => ({
      generatorEvidence: { version: 1, approvedAt: '2026-11-02T00:00:00Z', approvedById: 1 },
      generatedImages: [
        {
          jobId: WORKFLOW,
          source: 'workflow',
          workflowId: WORKFLOW,
          blobs: [
            {
              blobId: OUTPUT,
              role: 'output',
              status: 'preserved',
              evidenceKey: OLD_KEY,
              sha256: 'b'.repeat(64),
              orchestratorJobId: 'job-1',
            },
            { blobId: INPUT, role: 'input', status: 'preserved', evidenceKey: 'k', sha256: 'c' },
          ],
        },
      ],
    });
    const written = () =>
      (
        dbMock.dbWrite.csamReport.update.mock.calls[0][0] as {
          data: { details: ReturnType<typeof report> & Record<string, never> };
        }
      ).data.details;
    beforeEach(() => dbMock.dbWrite.csamReport.update.mockClear());
    const blobOf = (details: ReturnType<typeof report>, blobId: string) =>
      details.generatedImages[0].blobs.find((b) => b.blobId === blobId) as Record<string, unknown>;

    it('excludes the file with its reason, keeps its copy, and withdraws the approval', async () => {
      dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([{ details: report() }] as never);

      await excludeGeneratorEvidenceFile({
        reportId: 3,
        userId: USER,
        moderatorId: 2,
        blobId: OUTPUT,
        reason: 'copy is damaged',
      });

      const details = written();
      expect(blobOf(details, OUTPUT)).toMatchObject({
        status: 'excluded',
        evidenceKey: OLD_KEY,
        orchestratorJobId: 'job-1',
        excluded: { reason: 'copy is damaged', byId: 2, status: 'preserved' },
      });
      expect(blobOf(details, INPUT).status).toBe('preserved');
      expect(details.generatorEvidence).toMatchObject({ approvedAt: null, approvedById: null });
    });

    it('refuses a file the report does not name', async () => {
      dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([{ details: report() }] as never);
      await expect(
        excludeGeneratorEvidenceFile({
          reportId: 3,
          userId: USER,
          moderatorId: 2,
          blobId: 'NOTINREPORT.png',
          reason: 'x x x',
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(dbMock.dbWrite.csamReport.update).not.toHaveBeenCalled();
    });

    it('re-copies the file to a new key, records the old copy, and withdraws the approval', async () => {
      dbMock.dbWrite.csamReport.findFirst.mockResolvedValueOnce({ details: report() } as never);
      dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([{ details: report() }] as never);
      const store = memoryStore();

      const result = await recopyGeneratorEvidenceFile(
        { reportId: 3, userId: USER, moderatorId: 2, blobId: OUTPUT },
        { config, store }
      );

      expect(result.status).toBe('preserved');
      const blob = blobOf(written(), OUTPUT);
      expect(blob.evidenceKey).not.toBe(OLD_KEY);
      expect(blob.orchestratorJobId).toBe('job-1');
      expect(blob.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(await store.read(blob.evidenceKey as string, bytes.length)).toEqual(
        new Uint8Array(bytes)
      );
      expect(blob.replaced).toEqual([
        expect.objectContaining({ evidenceKey: OLD_KEY, sha256: 'b'.repeat(64), byId: 2 }),
      ]);
      expect(written().generatorEvidence).toMatchObject({ approvedAt: null });
    });

    it('does not undo an exclusion made while the file was being copied', async () => {
      dbMock.dbWrite.csamReport.findFirst.mockResolvedValueOnce({ details: report() } as never);
      const excludedMeanwhile = report();
      Object.assign(excludedMeanwhile.generatedImages[0].blobs[0], { status: 'excluded' });
      dbMock.dbWrite.$queryRaw.mockResolvedValueOnce([{ details: excludedMeanwhile }] as never);

      await expect(
        recopyGeneratorEvidenceFile(
          { reportId: 3, userId: USER, moderatorId: 2, blobId: OUTPUT },
          { config, store: memoryStore() }
        )
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(dbMock.dbWrite.csamReport.update).not.toHaveBeenCalled();
    });

    it('leaves the report as it was when the generator no longer has the file', async () => {
      dbMock.dbWrite.csamReport.findFirst.mockResolvedValueOnce({ details: report() } as never);
      vi.mocked(globalThis.fetch).mockResolvedValue(new Response(null, { status: 404 }));

      const result = await recopyGeneratorEvidenceFile(
        { reportId: 3, userId: USER, moderatorId: 2, blobId: OUTPUT },
        { config, store: memoryStore() }
      );

      expect(result.status).toBe('gone');
      expect(dbMock.dbWrite.csamReport.update).not.toHaveBeenCalled();
    });
  });
});
