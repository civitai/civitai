import { beforeEach, describe, expect, it, vi } from 'vitest';

const brake = vi.hoisted(() => ({
  pauseSends: vi.fn(),
  readBrake: vi.fn(async () => ({ paused: false })),
}));
vi.mock('$lib/server/cases/brake', () => brake);
vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
const imports = vi.hoisted(() => ({
  batchCounts: vi.fn(async () => []),
  importSentJsonl: vi.fn(),
  resolveSending: vi.fn(),
  ImportRefusedError: class extends Error {},
}));
vi.mock('$lib/server/cases/backlog-import', () => imports);
const service = vi.hoisted(() => ({
  batchPreview: vi.fn(async () => [{ id: 1, to: 'someone@example.test' }]),
  caseDataBlocked: vi.fn(async () => null),
  casesStoreMessage: vi.fn(() => 'store down'),
  isBatchRunning: vi.fn(async () => false),
  startBatchSend: vi.fn(async () => 'started'),
  startExport: vi.fn(async () => []),
  STALE_SENDING_MS: 600_000,
}));
vi.mock('$lib/server/cases/cases.service', () => service);

const { load, actions } = await import('../batch/[batchId]/+page.server');
const { GET } = await import('../batch/[batchId]/export/+server');

const event = (grants: Record<string, boolean>, form: Record<string, string> = {}) =>
  ({
    params: { batchId: 'backlog-1' },
    locals: { grants, user: { id: 7 } },
    request: { formData: async () => new Map(Object.entries(form)) as unknown as FormData },
  } as never);

beforeEach(() => vi.clearAllMocks());

describe('/cases/batch grants', () => {
  it('shows recipients only to a cases.pii holder, and reads them only then', async () => {
    const without = (await load(event({}))) as { preview: unknown };
    expect(without.preview).toBeNull();
    expect(service.batchPreview).not.toHaveBeenCalled();

    const withPii = (await load(event({ 'cases.pii': true }))) as { preview: unknown[] };
    expect(withPii.preview).toHaveLength(1);
    expect(service.batchPreview).toHaveBeenCalledWith('backlog-1', { actorId: 7 });
  });

  it('refuses send, importSent and resolve without cases.act', async () => {
    for (const action of [actions.send!, actions.importSent!, actions.resolve!]) {
      expect(((await action(event({ 'cases.pii': true }))) as { status: number }).status).toBe(403);
    }
    expect(service.startBatchSend).not.toHaveBeenCalled();
    expect(imports.importSentJsonl).not.toHaveBeenCalled();
    expect(imports.resolveSending).not.toHaveBeenCalled();
  });

  it('refuses the export without cases.act, and records nothing', async () => {
    await expect(GET(event({ 'cases.pii': true }))).rejects.toMatchObject({ status: 403 });
    expect(service.startExport).not.toHaveBeenCalled();
    expect(brake.pauseSends).not.toHaveBeenCalled();
  });
});
