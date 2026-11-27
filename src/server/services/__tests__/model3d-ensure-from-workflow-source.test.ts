import { serverCopyTablesSql } from '@civitai/db-queries/test/image-uses';
import { PGlite } from '@electric-sql/pglite';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { ensureModel3DFromWorkflow } from '~/server/services/model3d.service';
import type { SessionUser } from '~/types/session';

const mocks = vi.hoisted(() => ({
  getWorkflow: vi.fn(),
  handlePolyGenWorkflowResult: vi.fn(),
  submitWorkflow: vi.fn(),
}));
vi.mock('@civitai/orchestration-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitWorkflow: mocks.submitWorkflow,
}));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getFliptVariant: vi.fn(async () => 's2'),
}));
vi.mock('~/server/orchestrator/get-orchestrator-token', () => ({
  getOrchestratorToken: vi.fn(async () => 'token'),
}));
vi.mock('~/server/services/orchestrator/workflows', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getWorkflow: mocks.getWorkflow,
}));
vi.mock('~/server/services/orchestrator/handlers/polyGen.handler', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  handlePolyGenWorkflowResult: mocks.handlePolyGenWorkflowResult,
}));
vi.mock('~/server/orchestrator/polygen/polygen-output', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getPolyGenPrimaryModel: vi.fn(() => ({
    url: 'https://orchestration.civitai.com/v2/consumer/blobs/MESH-0.glb',
    format: 'glb',
    nsfwLevel: 1,
  })),
  getPolyGenPostBlock: vi.fn(() => undefined),
}));

const user = { id: 42, username: 'maker', isModerator: false } as SessionUser;
// image id -> owning user id
const images: Record<number, number> = { 11: user.id, 22: 7, 55: user.id, 66: user.id };

function workflowWith(metadata: Record<string, unknown>) {
  return {
    id: 'wf-1',
    metadata,
    steps: [{ $type: 'polyGen', output: { thumbnail: { nsfwLevel: 1 } } }],
  };
}

beforeEach(() => {
  mocks.submitWorkflow.mockReset();
  redisMock.redis.get.mockClear();
  mocks.handlePolyGenWorkflowResult.mockReset();
  mocks.getWorkflow.mockReset();
  dbMock.dbRead.model3D.findUnique.mockReset();
  // Not materialised yet on the first lookup; present after the handler runs.
  dbMock.dbRead.model3D.findUnique
    .mockResolvedValueOnce(null)
    .mockResolvedValue({ id: 500, userId: user.id, status: 'Draft', deletedAt: null });
  for (const client of [dbMock.dbRead, dbMock.dbWrite]) {
    client.image.findUnique.mockReset();
    client.image.findUnique.mockImplementation(async ({ where }: { where: { id: number } }) =>
      where.id in images ? { userId: images[where.id] } : null
    );
  }
});

// The use check runs its real SQL: a copy pointed at by its entry, and one named only by its key.
const POINTED_COPY = 55;
const KEYED_COPY = 66;
let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "Image" (id int PRIMARY KEY, url text NOT NULL);
    ${serverCopyTablesSql};
    INSERT INTO "Image" VALUES (11, 'own'), (${POINTED_COPY}, 'pointed'), (${KEYED_COPY}, 'keyed');
    INSERT INTO "ServiceDealFileEntry" ("imageId", "scanKey")
      VALUES (${POINTED_COPY}, NULL), (NULL, 'keyed');
  `);
});
afterAll(() => pg.close());
const bridgeUseCheck = () => {
  const raw = pgliteRaw(pg);
  dbMock.dbWrite.$queryRaw.mockImplementation(((s: TemplateStringsArray, ...v: unknown[]) =>
    raw.queryRaw(s, ...v)) as never);
};
beforeEach(bridgeUseCheck);

async function sourceImageIdHandedOn(metadata: Record<string, unknown>) {
  mocks.getWorkflow.mockResolvedValue(workflowWith(metadata));
  await ensureModel3DFromWorkflow({ input: { workflowId: 'wf-1' }, user, ctx: {} as never });
  expect(mocks.handlePolyGenWorkflowResult).toHaveBeenCalledTimes(1);
  return mocks.handlePolyGenWorkflowResult.mock.calls[0][0].sourceImageId;
}

// Workflow metadata is user-patchable, so the source image id in it is a claim, not a fact.
describe('ensureModel3DFromWorkflow source image', () => {
  it("keeps the caller's own source image", async () => {
    expect(await sourceImageIdHandedOn({ sourceImageId: 11 })).toBe(11);
  });

  it("drops another user's image, and one that does not exist, but still materialises", async () => {
    expect(await sourceImageIdHandedOn({ sourceImageId: 22 })).toBeUndefined();
    mocks.handlePolyGenWorkflowResult.mockReset();
    dbMock.dbRead.model3D.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ id: 500, userId: user.id, status: 'Draft', deletedAt: null });
    expect(await sourceImageIdHandedOn({ sourceImageId: 999 })).toBeUndefined();
  });

  it.each([
    ['pointed at by its entry', POINTED_COPY],
    ['named only by its key', KEYED_COPY],
  ])("drops the caller's own deal file copy (%s), but still materialises", async (_, id) => {
    expect(await sourceImageIdHandedOn({ sourceImageId: id })).toBeUndefined();
  });

  it("keeps the caller's own plain image under the same check (control)", async () => {
    expect(await sourceImageIdHandedOn({ sourceImageId: 11 })).toBe(11);
  });

  it('passes no source image when the metadata has none', async () => {
    expect(await sourceImageIdHandedOn({})).toBeUndefined();
  });

  it('ignores a source image id that is not a positive integer', async () => {
    expect(await sourceImageIdHandedOn({ sourceImageId: 1.5 })).toBeUndefined();
    expect(dbMock.dbRead.image.findUnique).not.toHaveBeenCalled();
  });
});

// Ownership is proven by the user's own token reading the result; the render and pending read must
// come after it.
describe('ensureModel3DFromWorkflow four-angle render', () => {
  const pendingKey = (userId: number) => expect.stringMatching(new RegExp(`:${userId}:wf-1$`));

  it("another user's click on the result neither reads its pending render nor asks for one", async () => {
    mocks.getWorkflow.mockRejectedValue(new Error('Not found'));
    await expect(
      ensureModel3DFromWorkflow({ input: { workflowId: 'wf-1' }, user, ctx: {} as never })
    ).rejects.toThrow();
    expect(mocks.getWorkflow).toHaveBeenCalledTimes(1);
    expect(mocks.handlePolyGenWorkflowResult).not.toHaveBeenCalled();
    expect(redisMock.redis.get).not.toHaveBeenCalled();
    expect(mocks.submitWorkflow).not.toHaveBeenCalled();
  });

  it("the owner's click reads only the owner's pending render", async () => {
    mocks.getWorkflow.mockResolvedValue({ ...workflowWith({}), allowMatureContent: false });
    await ensureModel3DFromWorkflow({
      input: { workflowId: 'wf-1' },
      user,
      ctx: {} as never,
    }).catch(() => undefined);
    expect(redisMock.redis.get).toHaveBeenCalledWith(pendingKey(user.id));
  });
});
