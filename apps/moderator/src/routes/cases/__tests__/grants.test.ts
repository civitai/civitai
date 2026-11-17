import { beforeEach, describe, expect, it, vi } from 'vitest';

const brake = vi.hoisted(() => ({ pauseSends: vi.fn(), resumeSends: vi.fn(), readBrake: vi.fn() }));
vi.mock('$lib/server/cases/brake', () => brake);
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
const imports = vi.hoisted(() => ({
  importBatch: vi.fn(),
  undoImport: vi.fn(),
  ImportRefusedError: class extends Error {},
}));
vi.mock('$lib/server/cases/backlog-import', () => imports);
vi.mock('$lib/server/cases/cases.service', () => ({
  listBatches: vi.fn(),
  casesStoreMessage: vi.fn(),
  caseDataBlocked: vi.fn(async () => null),
}));

const { actions } = await import('../+page.server');

const event = (grants: Record<string, boolean>, form: Record<string, string> = {}) =>
  ({
    locals: { grants, user: { id: 7 } },
    request: { formData: async () => new Map(Object.entries(form)) as unknown as FormData },
  } as never);

beforeEach(() => vi.clearAllMocks());

describe('/cases grants', () => {
  it('lets a cases.act holder pause but not resume', async () => {
    const act = { 'cases.act': true };
    await actions.pause!(event(act, { reason: 'checking a bounce' }));
    expect(brake.pauseSends).toHaveBeenCalledWith(7, 'checking a bounce');

    const refused = (await actions.resume!(event(act))) as { status: number };
    expect(refused.status).toBe(403);
    expect(brake.resumeSends).not.toHaveBeenCalled();
  });

  it('refuses pause without cases.act', async () => {
    const refused = (await actions.pause!(event({}, { reason: 'x' }))) as { status: number };
    expect(refused.status).toBe(403);
    expect(brake.pauseSends).not.toHaveBeenCalled();
  });

  it('resumes only for a cases.unpause holder', async () => {
    await actions.resume!(event({ 'cases.unpause': true }));
    expect(brake.resumeSends).toHaveBeenCalledTimes(1);
  });

  it('refuses import and undo without cases.act', async () => {
    const none = {};
    expect(((await actions.import!(event(none))) as { status: number }).status).toBe(403);
    expect(
      ((await actions.undo!(event(none, { batchId: 'b-1' }))) as { status: number }).status
    ).toBe(403);
    expect(imports.importBatch).not.toHaveBeenCalled();
    expect(imports.undoImport).not.toHaveBeenCalled();
  });
});
