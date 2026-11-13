import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HarnessClient from './harness-client';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const harness = vi.hoisted(() => ({ getPrompts: vi.fn() }));
vi.mock('./harness-client', async (importOriginal) => ({
  ...(await importOriginal<typeof HarnessClient>()),
  ...harness,
}));

const { LabHarnessError } = await import('./harness-client');
const { getVersion, loadPrompts } = await import('./version');

const v = (id: number, key = 'base') => ({
  id,
  key,
  content: `TEXT ${id}`,
  note: null,
  createdById: 1,
  createdAt: 'x',
});

beforeEach(() => {
  vi.clearAllMocks();
  harness.getPrompts.mockResolvedValue({
    active: { base: { id: 3, key: 'base', content: 'TEXT 3' } },
    config: { model: 'm', maxInputChars: 1, thinking: false },
    history: [v(3), v(2)],
  });
});

describe('getVersion', () => {
  it('returns the version and the active one from a single read of that key', async () => {
    const res = await getVersion('base', 2);
    expect(res.version).toMatchObject({ id: 2, content: 'TEXT 2' });
    expect(res.active).toMatchObject({ id: 3 });
    expect(res.prompts.active.base.id).toBe(3);
    expect(harness.getPrompts).toHaveBeenCalledExactlyOnceWith('base');
  });

  it('has no version for an id outside the loaded history', async () => {
    expect((await getVersion('base', 99)).version).toBeNull();
  });

  it('does not match a version of another key', async () => {
    harness.getPrompts.mockResolvedValue({
      active: {},
      config: {},
      history: [v(2, 'label:scam')],
    });
    const res = await getVersion('base', 2);
    expect(res.version).toBeNull();
    expect(res.active).toBeUndefined();
  });

  it('lets a harness failure through for the caller to word', async () => {
    harness.getPrompts.mockRejectedValue(new Error('down'));
    await expect(getVersion('base', 2)).rejects.toThrow('down');
  });
});

describe('loadPrompts', () => {
  it('wraps the loaded prompts', async () => {
    const res = await loadPrompts('base', 'prompts');
    expect(res).toMatchObject({ ok: true, value: { active: { base: { id: 3 } } } });
    expect(harness.getPrompts).toHaveBeenCalledExactlyOnceWith('base');
  });

  it('turns a harness failure into a message naming what failed to load', async () => {
    harness.getPrompts.mockRejectedValue(new LabHarnessError('harness down'));
    expect(await loadPrompts('base', 'policy prompt')).toEqual({
      ok: false,
      error: 'Could not load the policy prompt: harness down',
    });
  });

  it('hides an unexpected failure behind a generic message', async () => {
    harness.getPrompts.mockRejectedValue(new Error('secret detail'));
    expect(await loadPrompts('base', 'prompts')).toEqual({
      ok: false,
      error: 'Could not load the prompts: unexpected error',
    });
  });
});
