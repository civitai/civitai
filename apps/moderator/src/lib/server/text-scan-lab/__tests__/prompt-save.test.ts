import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HarnessClient from '$lib/server/text-scan-lab/harness-client';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const harness = vi.hoisted(() => ({ getPrompts: vi.fn(), putPrompt: vi.fn() }));
vi.mock('$lib/server/text-scan-lab/harness-client', async (importOriginal) => ({
  ...(await importOriginal<typeof HarnessClient>()),
  ...harness,
}));

const { restorePrompt, restoreSchema, savePrompt, saveSchema } = await import('../prompt-save');
const { LabHarnessError, StalePromptError } = await import(
  '$lib/server/text-scan-lab/harness-client'
);

const version = (id: number, content: string) => ({
  id,
  key: 'base',
  content,
  note: null,
  createdById: 1,
  createdAt: 'x',
});
const prompts = (activeId: number, activeText = `TEXT ${activeId}`) => ({
  active: { base: { id: activeId, key: 'base', content: activeText } },
  config: { model: 'm', maxInputChars: 1000, thinking: false },
  history: [version(3, 'TEXT 3'), version(2, 'TEXT 2'), version(1, 'TEXT 1')],
});

beforeEach(() => {
  vi.clearAllMocks();
  harness.getPrompts.mockResolvedValue(prompts(3));
  harness.putPrompt.mockResolvedValue({ id: 4, key: 'base' });
});

describe('saveSchema', () => {
  it('needs no note, and reads an empty base as "no version yet"', () => {
    expect(saveSchema.parse({ key: 'base', content: 'X', baseId: '' })).toEqual({
      key: 'base',
      content: 'X',
      baseId: null,
      note: undefined,
    });
    expect(saveSchema.parse({ key: 'base', content: 'X', baseId: '3', note: '  ' }).note).toBe(
      undefined
    );
  });

  it('refuses blank content, a missing base and an unknown key', () => {
    expect(saveSchema.safeParse({ key: 'base', content: '  ', baseId: '3' }).success).toBe(false);
    expect(saveSchema.safeParse({ key: 'base', content: 'X' }).success).toBe(false);
    expect(saveSchema.safeParse({ key: 'nope', content: 'X', baseId: '3' }).success).toBe(false);
  });

  it('refuses base version 0', () => {
    expect(saveSchema.safeParse({ key: 'base', content: 'X', baseId: '0' }).success).toBe(false);
    expect(restoreSchema.safeParse({ key: 'base', id: '2', baseId: '0' }).success).toBe(false);
  });
});

describe('savePrompt', () => {
  it('saves with the draft base and no note', async () => {
    expect(await savePrompt({ key: 'base', content: 'X', baseId: 3, note: undefined })).toEqual({
      saved: { key: 'base', id: 4 },
    });
    expect(harness.putPrompt).toHaveBeenCalledExactlyOnceWith('base', 'X', {
      note: undefined,
      baseId: 3,
    });
  });

  it('returns 409 and names the key when the draft base is stale', async () => {
    harness.putPrompt.mockRejectedValue(new StalePromptError('newer'));
    expect(
      await savePrompt({ key: 'label:scam', content: 'X', baseId: 3, note: undefined })
    ).toMatchObject({
      status: 409,
      data: { stale: 'label:scam' },
    });
  });

  it('says a refused save was not saved', async () => {
    harness.putPrompt.mockRejectedValue(new LabHarnessError('invalid request', true));
    const res = await savePrompt({ key: 'base', content: 'X', baseId: 3, note: undefined });
    expect(res).toMatchObject({ status: 502 });
    const { error } = (res as { data: { error: string } }).data;
    expect(error).toMatch(/was not saved/);
    expect(error).not.toMatch(/may or may not/);
  });

  it('says a failed save may or may not have gone through', async () => {
    harness.putPrompt.mockRejectedValue(new LabHarnessError('harness down'));
    const res = await savePrompt({ key: 'base', content: 'X', baseId: 3, note: undefined });
    expect(res).toMatchObject({ status: 502 });
    expect((res as { data: { error: string } }).data.error).toMatch(/may or may not/);
  });
});

describe('restorePrompt', () => {
  const input = (patch: Record<string, unknown> = {}) =>
    restoreSchema.parse({ key: 'base', id: '2', baseId: '3', ...patch });

  it('saves the stored text of the old version with a default note', async () => {
    expect(await restorePrompt(input({ content: 'FORGED' }))).toEqual({
      saved: { key: 'base', id: 4 },
    });
    expect(harness.putPrompt).toHaveBeenCalledExactlyOnceWith('base', 'TEXT 2', {
      note: 'Restored #2',
      baseId: 3,
    });
  });

  it('keeps a note the moderator wrote', async () => {
    await restorePrompt(input({ note: 'roll back' }));
    expect(harness.putPrompt.mock.calls[0][2]).toEqual({ note: 'roll back', baseId: 3 });
  });

  it('returns 404 for an id outside the loaded versions', async () => {
    expect(await restorePrompt(input({ id: '99' }))).toMatchObject({ status: 404 });
    expect(harness.putPrompt).not.toHaveBeenCalled();
  });

  it('refuses the current version, and an old one whose text equals the current text', async () => {
    expect(await restorePrompt(input({ id: '3' }))).toMatchObject({ status: 400 });
    harness.getPrompts.mockResolvedValue(prompts(3, 'TEXT 2'));
    expect(await restorePrompt(input())).toMatchObject({ status: 400 });
    expect(harness.putPrompt).not.toHaveBeenCalled();
  });

  it('returns 409 when the page saw an older current version', async () => {
    expect(await restorePrompt(input({ baseId: '2' }))).toMatchObject({ status: 409 });
    expect(harness.putPrompt).not.toHaveBeenCalled();
  });

  it('returns 409 when the current version moves between the read and the save', async () => {
    harness.putPrompt.mockRejectedValue(new StalePromptError('newer'));
    expect(await restorePrompt(input())).toMatchObject({ status: 409 });
  });

  it('says plainly when the versions cannot be loaded', async () => {
    harness.getPrompts.mockRejectedValue(new LabHarnessError('harness down'));
    expect(await restorePrompt(input())).toMatchObject({ status: 502 });
  });
});
