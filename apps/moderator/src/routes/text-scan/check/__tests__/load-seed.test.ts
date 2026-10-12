import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Check's `load` with the harness faked: `?key=&from=` seeds a draft from a loaded version. */

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const harness = vi.hoisted(() => ({ getPrompts: vi.fn(), putPrompt: vi.fn() }));
vi.mock('$lib/server/text-scan-lab/harness-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/text-scan-lab/harness-client')>()),
  ...harness,
}));

const { load } = await import('../+page.server');
const { LabHarnessError } = await import('$lib/server/text-scan-lab/harness-client');

const run = (query = '') =>
  load({ url: new URL(`http://localhost/text-scan/check${query}`) } as unknown as Parameters<
    typeof load
  >[0]) as Promise<Record<string, unknown>>;

const prompts = {
  active: { base: { id: 3, key: 'base', content: 'ACTIVE BASE' } },
  config: { model: 'm', maxInputChars: 1000, thinking: false },
  history: [
    { id: 3, key: 'base', content: 'ACTIVE BASE', note: null, createdById: 1, createdAt: 'x' },
    { id: 2, key: 'base', content: 'OLD BASE', note: null, createdById: 1, createdAt: 'x' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  harness.getPrompts.mockResolvedValue(prompts);
});

describe('load seed', () => {
  it('has no seed without params, and asks for no history', async () => {
    const res = await run();
    expect(res).toMatchObject({ seed: null, seedNotice: null });
    expect(harness.getPrompts).toHaveBeenCalledWith(undefined);
  });

  it('seeds from the version with that id in the key history', async () => {
    const res = await run('?key=base&from=2');
    expect(harness.getPrompts).toHaveBeenCalledWith('base');
    expect(res).toMatchObject({
      seed: { key: 'base', content: 'OLD BASE', id: 2 },
      seedNotice: null,
      active: { ok: true, ids: { base: 3 } },
    });
  });

  it('shows a notice when the id is not among the loaded versions', async () => {
    const res = await run('?key=base&from=99');
    expect(res.seed).toBeNull();
    expect(res.seedNotice).toMatch(/Version #99/);
  });

  it('shows a notice for an invalid key or id, without asking for history', async () => {
    for (const q of ['?key=nope&from=2', '?key=base&from=abc', '?key=base']) {
      harness.getPrompts.mockClear();
      const res = await run(q);
      expect(res.seed).toBeNull();
      expect(res.seedNotice).toMatch(/not valid/);
      expect(harness.getPrompts).toHaveBeenCalledWith(undefined);
    }
  });

  it('shows a notice when the prompts cannot be loaded', async () => {
    harness.getPrompts.mockRejectedValue(new LabHarnessError('harness down'));
    const res = await run('?key=base&from=2');
    expect(res.seed).toBeNull();
    expect(res.active).toMatchObject({ ok: false });
    expect(res.seedNotice).toMatch(/Could not load/);
  });
});
