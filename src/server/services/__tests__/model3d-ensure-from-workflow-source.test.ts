import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { ensureModel3DFromWorkflow } from '~/server/services/model3d.service';
import type { SessionUser } from '~/types/session';

const mocks = vi.hoisted(() => ({
  getWorkflow: vi.fn(),
  handlePolyGenWorkflowResult: vi.fn(),
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
  getPolyGenPrimaryModel: vi.fn(() => ({ url: 'https://x/model.glb', nsfwLevel: 1 })),
  getPolyGenPostBlock: vi.fn(() => undefined),
}));

const user = { id: 42, username: 'maker', isModerator: false } as SessionUser;
// image id -> owning user id
const images: Record<number, number> = { 11: user.id, 22: 7 };

function workflowWith(metadata: Record<string, unknown>) {
  return {
    id: 'wf-1',
    metadata,
    steps: [{ $type: 'polyGen', output: { thumbnail: { nsfwLevel: 1 } } }],
  };
}

beforeEach(() => {
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

  it('passes no source image when the metadata has none', async () => {
    expect(await sourceImageIdHandedOn({})).toBeUndefined();
  });

  it('ignores a source image id that is not a positive integer', async () => {
    expect(await sourceImageIdHandedOn({ sourceImageId: 1.5 })).toBeUndefined();
    expect(dbMock.dbRead.image.findUnique).not.toHaveBeenCalled();
  });
});
