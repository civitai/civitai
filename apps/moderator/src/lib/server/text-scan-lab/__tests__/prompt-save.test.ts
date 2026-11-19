import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as HarnessClient from '$lib/server/text-scan-lab/harness-client';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const harness = vi.hoisted(() => ({
  getPrompts: vi.fn(),
  putPrompt: vi.fn(),
  holdsMainPermission: vi.fn(),
}));
const gate = vi.hoisted(() => ({ checkIntentPublish: vi.fn() }));
vi.mock('$lib/server/moderator-db', () => ({ getModeratorDb: () => ({}) }));
vi.mock('$lib/server/text-scan-tests/publish-gate', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ...gate,
}));
vi.mock('$lib/server/text-scan-lab/harness-client', async (importOriginal) => ({
  ...(await importOriginal<typeof HarnessClient>()),
  ...harness,
}));

const { restorePrompt, restoreSchema, savePrompt, saveSchema } = await import('../prompt-save');
const { LabHarnessError, StalePromptError } = await import(
  '$lib/server/text-scan-lab/harness-client'
);

const USER = 990200013;
const INTENT = 'label:model-com-face-intent' as const;

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
  harness.holdsMainPermission.mockResolvedValue(true);
  gate.checkIntentPublish.mockResolvedValue({ ok: true, runId: 7 });
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
    expect(
      await savePrompt({ key: 'base', content: 'X', baseId: 3, note: undefined }, USER)
    ).toEqual({
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
      await savePrompt({ key: 'label:scam', content: 'X', baseId: 3, note: undefined }, USER)
    ).toMatchObject({
      status: 409,
      data: { stale: 'label:scam' },
    });
  });

  it('says a refused save was not saved', async () => {
    harness.putPrompt.mockRejectedValue(new LabHarnessError('invalid request', true));
    const res = await savePrompt({ key: 'base', content: 'X', baseId: 3, note: undefined }, USER);
    expect(res).toMatchObject({ status: 502 });
    const { error } = (res as { data: { error: string } }).data;
    expect(error).toMatch(/was not saved/);
    expect(error).not.toMatch(/may or may not/);
  });

  it('says a failed save may or may not have gone through', async () => {
    harness.putPrompt.mockRejectedValue(new LabHarnessError('harness down'));
    const res = await savePrompt({ key: 'base', content: 'X', baseId: 3, note: undefined }, USER);
    expect(res).toMatchObject({ status: 502 });
    expect((res as { data: { error: string } }).data.error).toMatch(/may or may not/);
  });
});

describe('savePrompt for the intent key', () => {
  const save = () => savePrompt({ key: INTENT, content: 'NEW', baseId: 3, note: undefined }, USER);

  it('saves once the saver holds the intent grant and their run passed', async () => {
    expect(await save()).toEqual({ saved: { key: INTENT, id: 4 } });
    expect(harness.holdsMainPermission).toHaveBeenCalledWith('textScanPromptPublishIntent');
    expect(gate.checkIntentPublish).toHaveBeenCalledWith(
      {},
      { content: 'NEW', userId: USER, live: prompts(3) }
    );
  });

  it('refuses, and saves nothing, when the run check refuses', async () => {
    gate.checkIntentPublish.mockResolvedValue({ ok: false, reason: 'no run' });
    const res = await save();
    expect(res).toMatchObject({ status: 409, data: { error: 'no run' } });
    expect(harness.putPrompt).not.toHaveBeenCalled();
  });

  it('refuses a saver without the intent grant before checking any run', async () => {
    harness.holdsMainPermission.mockResolvedValue(false);
    expect(await save()).toMatchObject({ status: 403 });
    expect(gate.checkIntentPublish).not.toHaveBeenCalled();
    expect(harness.putPrompt).not.toHaveBeenCalled();
  });

  it('refuses when the live prompts cannot be read', async () => {
    harness.getPrompts.mockRejectedValue(new LabHarnessError('down', false));
    expect(await save()).toMatchObject({ status: 502 });
    expect(harness.putPrompt).not.toHaveBeenCalled();
  });

  it('leaves the other keys ungated', async () => {
    await savePrompt({ key: 'label:scam', content: 'X', baseId: 3, note: undefined }, USER);
    expect(gate.checkIntentPublish).not.toHaveBeenCalled();
    expect(harness.putPrompt).toHaveBeenCalled();
  });

  it('restores an intent version with no run', async () => {
    gate.checkIntentPublish.mockResolvedValue({ ok: false, reason: 'no run' });
    harness.getPrompts.mockResolvedValue({
      ...prompts(3),
      active: { [INTENT]: { id: 3, key: INTENT, content: 'TEXT 3' } },
      history: [version(3, 'TEXT 3'), version(2, 'TEXT 2')].map((v) => ({ ...v, key: INTENT })),
    });
    expect(await restorePrompt({ key: INTENT, id: 2, baseId: 3, note: undefined })).toEqual({
      saved: { key: INTENT, id: 4 },
    });
    expect(gate.checkIntentPublish).not.toHaveBeenCalled();
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
      restore: true,
    });
  });

  it('keeps a note the moderator wrote, after the version it restores', async () => {
    await restorePrompt(input({ note: 'roll back' }));
    const [, content, opts] = harness.putPrompt.mock.calls[0];
    // The audit row of the put records this note and baseId: the restore's to- and from-version.
    expect(opts).toEqual({
      note: `Restored #${input({}).id}: roll back`,
      baseId: 3,
      // Marks the put a rollback: the main app then refuses revoked text even for a holder.
      restore: true,
    });
    expect(content).toBe(`TEXT ${input({}).id}`);
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
