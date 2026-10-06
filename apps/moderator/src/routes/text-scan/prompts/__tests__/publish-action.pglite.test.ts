import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The prompts page's write actions over real draft rows, with the harness faked. Publishing puts each
 * key live one at a time and nothing rolls back, so what a refusal says was published is the record.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, '../../../../../text-scan-lab/schema.sql'), 'utf8');

const holder = vi.hoisted(() => ({ pg: null as PGlite | null }));

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));
vi.mock('$lib/server/moderator-db', async () => {
  const { Kysely } = await import('kysely');
  const { pgliteDialect } = await import('$lib/server/__tests__/abuse-detection-pglite.harness');
  let db: unknown;
  let bound: PGlite | null = null;
  return {
    getModeratorDb: () => {
      if (bound !== holder.pg) {
        bound = holder.pg;
        db = new Kysely({ dialect: pgliteDialect(holder.pg!) });
      }
      return db;
    },
  };
});

const harness = vi.hoisted(() => ({ getPrompts: vi.fn(), putPrompt: vi.fn() }));
vi.mock('$lib/server/text-scan-lab/harness-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/text-scan-lab/harness-client')>()),
  getPrompts: harness.getPrompts,
  putPrompt: harness.putPrompt,
}));

const { actions } = await import('../+page.server');
const { LabHarnessError } = await import('$lib/server/text-scan-lab/harness-client');
const { createDraft, getDraft, updateDraft } = await import(
  '$lib/server/text-scan-lab/drafts.service'
);

const MOD = 990001;
const PUBLISH = { 'textScan.prompt.publish': true };

type ActionName = keyof typeof actions;
const run = (name: ActionName, grants: Record<string, boolean>, fields: Record<string, string>) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  const event = {
    request: { formData: async () => data },
    locals: { user: { id: MOD }, grants },
  } as unknown as Parameters<(typeof actions)[ActionName]>[0];
  return actions[name](event);
};

const activePrompts = (active: Record<string, { id: number; content: string }> = {}) => ({
  active: Object.fromEntries(Object.entries(active).map(([key, p]) => [key, { key, ...p }])),
  config: { model: 'm', maxInputChars: 1000, thinking: false },
});

beforeEach(async () => {
  vi.clearAllMocks();
  holder.pg = await PGlite.create();
  await holder.pg.exec(SCHEMA);
  harness.getPrompts.mockResolvedValue(activePrompts());
});

const twoKeyDraft = () =>
  createDraft(
    { name: 'd', prompts: { base: 'BASE PROMPT', 'label:scam': 'SCAM DEF' }, note: 'why' },
    MOD
  );
const publishFields = (draft: { id: number; updatedAt: Date }, note = 'ship it') => ({
  draftId: String(draft.id),
  note,
  expectedUpdatedAt: draft.updatedAt.toISOString(),
});

describe('publish', () => {
  it('returns 403 without textScan.prompt.publish, before touching the harness', async () => {
    const draft = await twoKeyDraft();
    const result = await run('publish', { 'textScan.testSet.edit': true }, publishFields(draft));
    expect(result).toMatchObject({ status: 403, data: { scope: 'denied' } });
    expect(harness.putPrompt).not.toHaveBeenCalled();
    expect((await getDraft(draft.id))?.publishedAt).toBeNull();
  });

  it('puts every key with the publish note, then marks the draft published with their ids', async () => {
    const draft = await twoKeyDraft();
    harness.putPrompt.mockImplementation(async (key: string) => ({
      id: key === 'base' ? 11 : 12,
      key,
    }));

    const result = await run('publish', PUBLISH, publishFields(draft));

    expect(result).toEqual({ success: true, published: ['base', 'label:scam'], unchanged: [] });
    expect(harness.putPrompt.mock.calls).toEqual([
      ['base', 'BASE PROMPT', 'ship it'],
      ['label:scam', 'SCAM DEF', 'ship it'],
    ]);
    expect(await getDraft(draft.id)).toMatchObject({
      publishedPromptIds: { base: 11, 'label:scam': 12 },
    });
  });

  it('names the keys already published when a later key fails, and leaves the draft unpublished', async () => {
    const draft = await twoKeyDraft();
    harness.putPrompt
      .mockResolvedValueOnce({ id: 11, key: 'base' })
      .mockRejectedValueOnce(new LabHarnessError('Publish text-scan prompt: harness down'));

    const result = await run('publish', PUBLISH, publishFields(draft));

    expect(result).toMatchObject({ status: 502, data: { published: ['base'] } });
    const error = (result as { data: { error: string } }).data.error;
    expect(error).toContain('Scam / phishing definition failed');
    expect(error).toContain('Already published: General instructions.');
    expect(error).toContain('The draft stays unpublished');
    expect((await getDraft(draft.id))?.publishedAt).toBeNull();
  });

  it('skips a key whose text is already live, so a retry after a partial publish adds no duplicate', async () => {
    const draft = await twoKeyDraft();
    harness.getPrompts.mockResolvedValue(
      activePrompts({ base: { id: 11, content: 'BASE PROMPT' } })
    );
    harness.putPrompt.mockResolvedValue({ id: 12, key: 'label:scam' });

    const result = await run('publish', PUBLISH, publishFields(draft));

    expect(result).toEqual({ success: true, published: ['label:scam'], unchanged: ['base'] });
    expect(harness.putPrompt).toHaveBeenCalledTimes(1);
    expect((await getDraft(draft.id))?.publishedPromptIds).toEqual({ base: 11, 'label:scam': 12 });
  });

  it('refuses with a reload message when the draft changed since the page loaded', async () => {
    const draft = await twoKeyDraft();
    await updateDraft(
      draft.id,
      { prompts: { base: 'OTHER TAB' }, note: null, expectedUpdatedAt: draft.updatedAt },
      MOD
    );

    const result = await run('publish', PUBLISH, publishFields(draft));

    expect(result).toMatchObject({ status: 409 });
    expect((result as { data: { error: string } }).data.error).toMatch(/changed since you loaded/);
    expect(harness.putPrompt).not.toHaveBeenCalled();
  });

  it('requires a publish note', async () => {
    const draft = await twoKeyDraft();
    const result = await run('publish', PUBLISH, publishFields(draft, '  '));
    expect(result).toMatchObject({ status: 400 });
    expect(harness.putPrompt).not.toHaveBeenCalled();
  });
});

describe('saveDraft', () => {
  it('refuses a blank key by name and writes nothing', async () => {
    const draft = await twoKeyDraft();
    const result = await run(
      'saveDraft',
      {},
      {
        draftId: String(draft.id),
        prompts: JSON.stringify({ base: 'BASE PROMPT', 'label:scam': ' ' }),
        note: '',
        expectedUpdatedAt: draft.updatedAt.toISOString(),
      }
    );
    expect(result).toMatchObject({ status: 400 });
    expect((result as { data: { error: string } }).data.error).toBe(
      'Scam / phishing definition is empty — write it, or reset it to current.'
    );
    expect(await getDraft(draft.id)).toEqual(draft);
  });

  it('refuses a stale save from a second tab with a reload message', async () => {
    const draft = await twoKeyDraft();
    const fields = (base: string) => ({
      draftId: String(draft.id),
      prompts: JSON.stringify({ base }),
      note: '',
      expectedUpdatedAt: draft.updatedAt.toISOString(),
    });
    expect(await run('saveDraft', {}, fields('TAB A'))).toEqual({ success: true });
    const second = await run('saveDraft', {}, fields('TAB B'));
    expect(second).toMatchObject({ status: 409 });
    expect((second as { data: { error: string } }).data.error).toMatch(/reload/);
    expect((await getDraft(draft.id))?.prompts).toEqual({ base: 'TAB A' });
  });
});
