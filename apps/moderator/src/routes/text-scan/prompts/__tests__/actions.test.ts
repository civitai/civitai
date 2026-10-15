import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HarnessClient from '$lib/server/text-scan-lab/harness-client';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const harness = vi.hoisted(() => ({ getPrompts: vi.fn(), putPrompt: vi.fn(), scanTexts: vi.fn() }));
vi.mock('$lib/server/text-scan-lab/harness-client', async (importOriginal) => ({
  ...(await importOriginal<typeof HarnessClient>()),
  ...harness,
}));

const { actions } = await import('../+page.server');
const { StalePromptError } = await import('$lib/server/text-scan-lab/harness-client');

const PUBLISH = { 'textScan.prompt.publish': true };
type Action = keyof typeof actions;
const post = (
  action: Action,
  fields: Record<string, string>,
  grants: Record<string, boolean> = PUBLISH
) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  const event = {
    request: { formData: async () => data },
    locals: { user: { id: 1 }, grants },
  } as unknown as Parameters<(typeof actions)['save']>[0];
  return (actions[action] as (e: typeof event) => Promise<unknown>)(event) as Promise<
    Record<string, unknown>
  >;
};

beforeEach(() => {
  vi.clearAllMocks();
  harness.putPrompt.mockResolvedValue({ id: 4, key: 'base' });
  harness.getPrompts.mockResolvedValue({
    active: { base: { id: 3, key: 'base', content: 'TEXT 3' } },
    config: { model: 'm', maxInputChars: 1000, thinking: false },
    history: [
      { id: 3, key: 'base', content: 'TEXT 3', note: null, createdById: 1, createdAt: 'x' },
      { id: 2, key: 'base', content: 'TEXT 2', note: null, createdById: 1, createdAt: 'x' },
    ],
  });
});

describe('save', () => {
  it('returns 403 without textScan.prompt.publish, before touching the harness', async () => {
    expect(await post('save', { key: 'base', content: 'X', baseId: '3' }, {})).toMatchObject({
      status: 403,
    });
    expect(harness.putPrompt).not.toHaveBeenCalled();
  });

  it('saves in one step, without a note', async () => {
    expect(await post('save', { key: 'base', content: 'X', baseId: '3' })).toEqual({
      saved: { key: 'base', id: 4 },
    });
    expect(harness.putPrompt).toHaveBeenCalledExactlyOnceWith('base', 'X', {
      note: undefined,
      baseId: 3,
    });
  });

  it("returns 409 and names the key when the draft's base is stale", async () => {
    harness.putPrompt.mockRejectedValue(new StalePromptError('newer'));
    expect(await post('save', { key: 'label:scam', content: 'X', baseId: '3' })).toMatchObject({
      status: 409,
      data: { stale: 'label:scam' },
    });
  });

  it('refuses a save with no base version before touching the harness', async () => {
    expect(await post('save', { key: 'base', content: 'X' })).toMatchObject({ status: 400 });
    expect(harness.putPrompt).not.toHaveBeenCalled();
  });
});

describe('restore', () => {
  it('returns 403 without textScan.prompt.publish', async () => {
    expect(await post('restore', { key: 'base', id: '2', baseId: '3' }, {})).toMatchObject({
      status: 403,
    });
    expect(harness.getPrompts).not.toHaveBeenCalled();
  });

  it('saves the stored text of the old version', async () => {
    await post('restore', { key: 'base', id: '2', baseId: '3', content: 'FORGED' });
    expect(harness.putPrompt).toHaveBeenCalledExactlyOnceWith('base', 'TEXT 2', {
      note: 'Restored #2',
      baseId: 3,
    });
  });
});

describe('try', () => {
  it('needs only the page grant', async () => {
    harness.scanTexts.mockResolvedValue({ results: [], system: null, rules: null });
    const res = await post('try', { input: 'hello there' }, {});
    expect(res).not.toMatchObject({ status: 403 });
    expect(harness.scanTexts).toHaveBeenCalled();
  });
});
