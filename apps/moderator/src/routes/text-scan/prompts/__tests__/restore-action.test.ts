import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Versions' `restore` action with the harness faked: an old version's text goes live as a new version. */

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const harness = vi.hoisted(() => ({ getPrompts: vi.fn(), putPrompt: vi.fn() }));
vi.mock('$lib/server/text-scan-lab/harness-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/text-scan-lab/harness-client')>()),
  ...harness,
}));

const { actions } = await import('../+page.server');
const { LabHarnessError } = await import('$lib/server/text-scan-lab/harness-client');

const GRANT = { 'textScan.prompt.publish': true };

const restore = (fields: Record<string, string>, grants: Record<string, boolean> = GRANT) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  const event = {
    request: { formData: async () => data },
    locals: { user: { id: 1 }, grants },
  } as unknown as Parameters<typeof actions.restore>[0];
  return actions.restore(event) as Promise<Record<string, unknown>>;
};

const version = (id: number, content: string) => ({
  id,
  key: 'base',
  content,
  note: null,
  createdById: 1,
  createdAt: 'x',
});

const prompts = (activeId: number) => ({
  active: { base: { id: activeId, key: 'base', content: `TEXT ${activeId}` } },
  config: { model: 'm', maxInputChars: 1000, thinking: false },
  history: [version(3, 'TEXT 3'), version(2, 'TEXT 2'), version(1, 'TEXT 1')],
});

const fields = { key: 'base', id: '2', activeId: '3', note: 'Restore #2' };

beforeEach(() => {
  vi.clearAllMocks();
  harness.getPrompts.mockResolvedValue(prompts(3));
  harness.putPrompt.mockResolvedValue({ id: 4, key: 'base' });
});

describe('restore', () => {
  it('returns 403 without textScan.prompt.publish, before touching the harness', async () => {
    expect(await restore(fields, {})).toMatchObject({ status: 403 });
    expect(harness.getPrompts).not.toHaveBeenCalled();
    expect(harness.putPrompt).not.toHaveBeenCalled();
  });

  it('requires a note', async () => {
    expect(await restore({ ...fields, note: ' ' })).toMatchObject({ status: 400 });
    expect(harness.putPrompt).not.toHaveBeenCalled();
  });

  it('refuses a missing or malformed id or key', async () => {
    for (const bad of [
      { key: 'base', note: 'n' },
      { ...fields, id: 'x' },
      { ...fields, key: 'nope' },
    ]) {
      expect(await restore(bad)).toMatchObject({ status: 400 });
    }
    expect(harness.putPrompt).not.toHaveBeenCalled();
  });

  it('returns 404 for an id that is not among the loaded versions', async () => {
    expect(await restore({ ...fields, id: '99' })).toMatchObject({ status: 404 });
    expect(harness.putPrompt).not.toHaveBeenCalled();
  });

  it('refuses to restore the version that is already current', async () => {
    expect(await restore({ ...fields, id: '3' })).toMatchObject({ status: 400 });
    expect(harness.putPrompt).not.toHaveBeenCalled();
  });

  it('publishes the stored text of the old version, not anything sent by the client', async () => {
    const res = await restore({ ...fields, content: 'FORGED' });
    expect(res).toEqual({ success: true, published: ['base'] });
    expect(harness.putPrompt).toHaveBeenCalledExactlyOnceWith('base', 'TEXT 2', 'Restore #2');
  });

  it('returns 409 when the page was loaded before the current version changed', async () => {
    expect(await restore({ ...fields, activeId: '2' })).toMatchObject({ status: 409 });
    expect(harness.putPrompt).not.toHaveBeenCalled();
  });

  it('returns 409 when the current version moved after it was read', async () => {
    harness.getPrompts.mockResolvedValueOnce(prompts(3)).mockResolvedValueOnce(prompts(4));
    expect(await restore(fields)).toMatchObject({ status: 409 });
    expect(harness.putPrompt).not.toHaveBeenCalled();
  });

  it('requires the version the page showed as current', async () => {
    const { activeId: _omit, ...without } = fields;
    expect(await restore(without)).toMatchObject({ status: 400 });
    expect(harness.putPrompt).not.toHaveBeenCalled();
  });

  it('says plainly when the prompts cannot be loaded', async () => {
    harness.getPrompts.mockRejectedValue(new LabHarnessError('harness down'));
    expect(await restore(fields)).toMatchObject({ status: 502 });
  });
});
