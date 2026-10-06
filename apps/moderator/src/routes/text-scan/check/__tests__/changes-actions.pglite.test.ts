import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Check page's "my changes" actions over real draft rows, with the harness faked: autosave and its
 * conflict token, propose, discard, and publishing straight from a working copy.
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
const { createDraft, getDraft, getWorkingCopy, saveWorkingCopy } = await import(
  '$lib/server/text-scan-lab/drafts.service'
);

const MOD = 990001;
const OTHER_MOD = 990002;
const PUBLISH = { 'textScan.prompt.publish': true };

type ActionName = keyof typeof actions;
const run = (
  name: ActionName,
  fields: Record<string, string>,
  { user = MOD, grants = {} as Record<string, boolean> } = {}
) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  const event = {
    request: { formData: async () => data },
    locals: { user: { id: user }, grants },
  } as unknown as Parameters<(typeof actions)[ActionName]>[0];
  return actions[name](event) as Promise<Record<string, unknown>>;
};
const errorOf = (r: unknown) => (r as { data: { error: string } }).data.error;

beforeEach(async () => {
  vi.clearAllMocks();
  holder.pg = await PGlite.create();
  await holder.pg.exec(SCHEMA);
  harness.getPrompts.mockResolvedValue({
    active: {},
    config: { model: 'm', maxInputChars: 1000, thinking: false },
  });
});

const save = (prompts: Record<string, string>, expected: string | null, extra = {}) =>
  run('saveChanges', {
    prompts: JSON.stringify(prompts),
    expectedUpdatedAt: expected ?? '',
    ...extra,
  });

describe('saveChanges (autosave)', () => {
  it('creates my working copy and hands back the token the next save must send', async () => {
    const first = await save({ base: 'BASE PROMPT' }, null);
    const copy = await getWorkingCopy(MOD);
    expect(first).toEqual({ draftId: copy!.id, updatedAt: copy!.updatedAt.toISOString() });

    const second = await save({ base: 'BASE 2' }, first.updatedAt as string);
    expect((await getWorkingCopy(MOD))?.prompts).toEqual({ base: 'BASE 2' });
    expect(second.updatedAt).not.toBe(first.updatedAt);
  });

  it('refuses a stale save from another tab with a reload message, keeping the other save', async () => {
    const first = await save({ base: 'TAB A' }, null);
    await save({ base: 'TAB A 2' }, first.updatedAt as string);
    const stale = await save({ base: 'TAB B' }, first.updatedAt as string);
    expect(stale).toMatchObject({ status: 409 });
    expect(errorOf(stale)).toMatch(/another tab — reload/);
    expect((await getWorkingCopy(MOD))?.prompts).toEqual({ base: 'TAB A 2' });
  });

  it('refuses a blank key by name', async () => {
    const res = await save({ base: 'BASE PROMPT', 'label:scam': ' ' }, null);
    expect(res).toMatchObject({ status: 400 });
    expect(errorOf(res)).toContain('label:scam');
    expect(await getWorkingCopy(MOD)).toBeNull();
  });

  it('deletes the copy when every change is reset', async () => {
    const first = await save({ base: 'BASE PROMPT' }, null);
    expect(await save({}, first.updatedAt as string)).toEqual({
      draftId: null,
      updatedAt: null,
    });
    expect(await getWorkingCopy(MOD)).toBeNull();
  });

  it("saves a proposed draft opened by its author, but never someone else's", async () => {
    const draft = await createDraft({ name: 'd', prompts: { base: 'B' }, note: 'why' }, OTHER_MOD);
    const fields = { draftId: String(draft.id) };

    const notMine = await save({ base: 'MINE' }, draft.updatedAt.toISOString(), fields);
    expect(notMine).toMatchObject({ status: 403 });

    const byAuthor = await run(
      'saveChanges',
      {
        prompts: JSON.stringify({ base: 'AUTHOR' }),
        expectedUpdatedAt: draft.updatedAt.toISOString(),
        ...fields,
      },
      { user: OTHER_MOD }
    );
    expect(byAuthor).toMatchObject({ draftId: draft.id });
    expect(await getDraft(draft.id)).toMatchObject({ prompts: { base: 'AUTHOR' }, note: 'why' });
  });

  it("treats another moderator's working copy as missing", async () => {
    const theirs = await saveWorkingCopy(OTHER_MOD, { base: 'THEIRS' }, null);
    const res = await save({ base: 'MINE' }, theirs!.updatedAt.toISOString(), {
      draftId: String(theirs!.id),
    });
    expect(res).toMatchObject({ status: 404 });
    expect((await getWorkingCopy(OTHER_MOD))?.prompts).toEqual({ base: 'THEIRS' });
  });
});

describe('proposeChanges', () => {
  it('names my copy as a proposed draft, a blank note stored as none', async () => {
    const saved = await save({ 'label:scam': 'SCAM DEF' }, null);
    const res = await run('proposeChanges', {
      name: ' tighter scam ',
      note: '  ',
      expectedUpdatedAt: saved.updatedAt as string,
    });
    expect(res).toEqual({ draftId: saved.draftId, name: 'tighter scam' });
    expect(await getDraft(saved.draftId as number)).toMatchObject({
      kind: 'proposed',
      name: 'tighter scam',
      note: null,
    });
    expect(await getWorkingCopy(MOD)).toBeNull();
  });

  it('refuses when the copy changed since the moderator last saw it', async () => {
    const seen = await save({ base: 'SEEN' }, null);
    await save({ base: 'OTHER TAB' }, seen.updatedAt as string);
    const res = await run('proposeChanges', {
      name: 'x',
      expectedUpdatedAt: seen.updatedAt as string,
    });
    expect(res).toMatchObject({ status: 409 });
    expect((await getWorkingCopy(MOD))?.kind).toBe('working');
  });
});

describe('discardChanges', () => {
  it('removes only my working copy', async () => {
    await save({ base: 'MINE' }, null);
    await saveWorkingCopy(OTHER_MOD, { base: 'THEIRS' }, null);
    expect(await run('discardChanges', {})).toEqual({ success: true });
    expect(await getWorkingCopy(MOD)).toBeNull();
    expect(await getWorkingCopy(OTHER_MOD)).not.toBeNull();
  });
});

describe('publish from Check', () => {
  it('needs textScan.prompt.publish', async () => {
    const saved = await save({ base: 'BASE PROMPT' }, null);
    const res = await run('publish', {
      draftId: String(saved.draftId),
      note: 'ship',
      expectedUpdatedAt: saved.updatedAt as string,
    });
    expect(res).toMatchObject({ status: 403 });
    expect(harness.putPrompt).not.toHaveBeenCalled();
  });

  it('publishes my working copy and names it from the publish note', async () => {
    const saved = await save({ base: 'BASE PROMPT' }, null);
    harness.putPrompt.mockResolvedValue({ id: 61, key: 'base' });
    const res = await run(
      'publish',
      {
        draftId: String(saved.draftId),
        note: 'Stricter base\nlonger reasoning here',
        expectedUpdatedAt: saved.updatedAt as string,
      },
      { grants: PUBLISH }
    );
    expect(res).toEqual({ success: true, published: ['base'], unchanged: [] });
    expect(await getDraft(saved.draftId as number)).toMatchObject({
      kind: 'proposed',
      name: 'Stricter base',
      publishedPromptIds: { base: 61 },
    });
    expect(await getWorkingCopy(MOD)).toBeNull();
  });

  it("refuses another moderator's working copy as not found, before touching the harness", async () => {
    const theirs = await saveWorkingCopy(OTHER_MOD, { base: 'THEIRS' }, null);
    const res = await run(
      'publish',
      {
        draftId: String(theirs!.id),
        note: 'ship',
        expectedUpdatedAt: theirs!.updatedAt.toISOString(),
      },
      { grants: PUBLISH }
    );
    expect(res).toMatchObject({ status: 404 });
    expect(harness.getPrompts).not.toHaveBeenCalled();
    expect(harness.putPrompt).not.toHaveBeenCalled();
    expect((await getWorkingCopy(OTHER_MOD))?.publishedAt).toBeNull();
  });
});
