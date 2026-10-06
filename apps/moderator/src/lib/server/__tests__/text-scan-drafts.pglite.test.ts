import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The prompt-draft service over the REAL `text-scan-lab/schema.sql`. The conflict guard is a predicate
 * on `updated_at` in the UPDATE itself, so only a real row can say whether a stale save moved it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(join(HERE, '../../../../text-scan-lab/schema.sql'), 'utf8');

const holder = vi.hoisted(() => ({ pg: null as PGlite | null }));

vi.mock('../moderator-db', async () => {
  const { Kysely } = await import('kysely');
  const { pgliteDialect } = await import('./abuse-detection-pglite.harness');
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

const {
  DraftConflictError,
  DraftNotFoundError,
  DraftPublishedError,
  DraftValidationError,
  createDraft,
  discardWorkingCopy,
  getDraft,
  getVisibleDraft,
  getWorkingCopy,
  listDrafts,
  markPublished,
  proposeWorkingCopy,
  saveWorkingCopy,
  updateDraft,
} = await import('../text-scan-lab/drafts.service');

const MOD = 990001;
const OTHER_MOD = 990002;
const AS_MOD = { userId: MOD, workingName: 'Published changes' };

beforeEach(async () => {
  holder.pg = await PGlite.create();
  await holder.pg.exec(SCHEMA);
});

const newDraft = () =>
  createDraft({ name: 'tighter scam', prompts: { 'label:scam': 'SCAM DEF' }, note: 'v2' }, MOD);

describe('createDraft', () => {
  it('stores the overrides and returns the row', async () => {
    const draft = await newDraft();
    expect(draft).toMatchObject({
      name: 'tighter scam',
      prompts: { 'label:scam': 'SCAM DEF' },
      note: 'v2',
      createdBy: MOD,
      updatedBy: MOD,
      publishedAt: null,
    });
    expect(await getDraft(draft.id)).toEqual(draft);
    expect((await listDrafts()).map((d) => d.id)).toEqual([draft.id]);
  });

  it('rejects a key outside base and the four labels', async () => {
    await expect(
      createDraft({ name: 'x', prompts: { 'label:violence': 'V' }, note: null }, MOD)
    ).rejects.toThrow(DraftValidationError);
    await expect(
      createDraft({ name: 'x', prompts: { system: 'S' }, note: null }, MOD)
    ).rejects.toThrow(/system/);
  });

  it('refuses a blank override and names the key', async () => {
    await expect(
      createDraft(
        { name: 'x', prompts: { base: 'BASE PROMPT', 'label:poi': '  \n ' }, note: null },
        MOD
      )
    ).rejects.toThrow(/label:poi/);
  });
});

describe('updateDraft', () => {
  it('saves against the updated_at it was loaded with, and moves it', async () => {
    const draft = await newDraft();
    const saved = await updateDraft(
      draft.id,
      { prompts: { base: 'BASE PROMPT' }, note: 'v3', expectedUpdatedAt: draft.updatedAt },
      OTHER_MOD
    );
    expect(saved).toMatchObject({
      prompts: { base: 'BASE PROMPT' },
      note: 'v3',
      updatedBy: OTHER_MOD,
    });
    expect(saved.updatedAt.getTime()).toBeGreaterThan(draft.updatedAt.getTime());
  });

  it('throws DraftConflictError when the draft moved since it was loaded (two tabs)', async () => {
    const draft = await newDraft();
    // Tab A saves first.
    await updateDraft(
      draft.id,
      { prompts: { base: 'TAB A' }, note: null, expectedUpdatedAt: draft.updatedAt },
      MOD
    );
    // Tab B still holds the original updated_at, even in the same millisecond.
    await expect(
      updateDraft(
        draft.id,
        { prompts: { base: 'TAB B' }, note: null, expectedUpdatedAt: draft.updatedAt },
        OTHER_MOD
      )
    ).rejects.toThrow(DraftConflictError);
    expect((await getDraft(draft.id))?.prompts).toEqual({ base: 'TAB A' });
  });

  it('refuses to update a published draft', async () => {
    const draft = await newDraft();
    const published = await markPublished(draft.id, { 'label:scam': 41 }, draft.updatedAt, AS_MOD);
    expect(published.publishedAt).toBeInstanceOf(Date);
    expect(published.publishedPromptIds).toEqual({ 'label:scam': 41 });

    await expect(
      updateDraft(
        draft.id,
        { prompts: { base: 'LATE' }, note: null, expectedUpdatedAt: published.updatedAt },
        MOD
      )
    ).rejects.toThrow(DraftPublishedError);
  });

  it('rejects an unknown key without writing', async () => {
    const draft = await newDraft();
    await expect(
      updateDraft(
        draft.id,
        { prompts: { 'label:other': 'X' }, note: null, expectedUpdatedAt: draft.updatedAt },
        MOD
      )
    ).rejects.toThrow(DraftValidationError);
    expect(await getDraft(draft.id)).toEqual(draft);
  });
});

describe('markPublished', () => {
  it('refuses when the draft moved after the publisher loaded it', async () => {
    const draft = await newDraft();
    await updateDraft(
      draft.id,
      { prompts: { base: 'EDITED' }, note: null, expectedUpdatedAt: draft.updatedAt },
      OTHER_MOD
    );
    await expect(markPublished(draft.id, { 'label:scam': 41 }, draft.updatedAt, AS_MOD)).rejects.toThrow(
      DraftConflictError
    );
  });

  it("keeps a proposed draft's name, whatever the publish note", async () => {
    const draft = await newDraft();
    const published = await markPublished(draft.id, { 'label:scam': 41 }, draft.updatedAt, {
      userId: OTHER_MOD,
      workingName: 'from the note',
    });
    expect(published.name).toBe('tighter scam');
  });

  it('refuses to publish twice', async () => {
    const draft = await newDraft();
    await markPublished(draft.id, { 'label:scam': 41 }, draft.updatedAt, AS_MOD);
    await expect(markPublished(draft.id, { 'label:scam': 42 }, draft.updatedAt, AS_MOD)).rejects.toThrow(
      DraftPublishedError
    );
  });
});

describe('working copy', () => {
  const save = (userId: number, prompts: Record<string, unknown>, expected: Date | null) =>
    saveWorkingCopy(userId, prompts, expected);

  it('is created on the first save and read back per moderator', async () => {
    expect(await getWorkingCopy(MOD)).toBeNull();
    const copy = await save(MOD, { 'label:nsfw': 'NSFW DEF' }, null);
    expect(copy).toMatchObject({
      kind: 'working',
      prompts: { 'label:nsfw': 'NSFW DEF' },
      createdBy: MOD,
      publishedAt: null,
    });
    expect(await getWorkingCopy(MOD)).toEqual(copy);
    expect(await getWorkingCopy(OTHER_MOD)).toBeNull();
  });

  it('keeps one working copy per moderator: a save updates it in place and moves the token', async () => {
    const first = await save(MOD, { base: 'BASE PROMPT' }, null);
    const second = await save(MOD, { base: 'BASE 2' }, first!.updatedAt);
    expect(second!.id).toBe(first!.id);
    expect(second!.updatedAt.getTime()).toBeGreaterThan(first!.updatedAt.getTime());
    expect((await getWorkingCopy(MOD))?.prompts).toEqual({ base: 'BASE 2' });
  });

  it('gives each moderator their own copy', async () => {
    const mine = await save(MOD, { base: 'MINE' }, null);
    const theirs = await save(OTHER_MOD, { base: 'THEIRS' }, null);
    expect(theirs!.id).not.toBe(mine!.id);
    expect((await getWorkingCopy(MOD))?.prompts).toEqual({ base: 'MINE' });
  });

  it('refuses a stale save (another tab saved first) without writing', async () => {
    const loaded = await save(MOD, { base: 'TAB A 1' }, null);
    await save(MOD, { base: 'TAB A 2' }, loaded!.updatedAt);
    await expect(save(MOD, { base: 'TAB B' }, loaded!.updatedAt)).rejects.toThrow(
      DraftConflictError
    );
    expect((await getWorkingCopy(MOD))?.prompts).toEqual({ base: 'TAB A 2' });
  });

  it('refuses a first save when another tab already created the copy', async () => {
    await save(MOD, { base: 'TAB A' }, null);
    await expect(save(MOD, { base: 'TAB B' }, null)).rejects.toThrow(DraftConflictError);
    expect((await getWorkingCopy(MOD))?.prompts).toEqual({ base: 'TAB A' });
  });

  it('refuses a save against a copy discarded in another tab', async () => {
    const loaded = await save(MOD, { base: 'BASE PROMPT' }, null);
    await discardWorkingCopy(MOD);
    await expect(save(MOD, { base: 'LATE' }, loaded!.updatedAt)).rejects.toThrow(
      DraftConflictError
    );
    expect(await getWorkingCopy(MOD)).toBeNull();
  });

  it('refuses a blank key and names it, without writing', async () => {
    const loaded = await save(MOD, { base: 'BASE PROMPT' }, null);
    await expect(
      save(MOD, { base: 'BASE PROMPT', 'label:scam': ' ' }, loaded!.updatedAt)
    ).rejects.toThrow(/label:scam/);
    expect(await getWorkingCopy(MOD)).toEqual(loaded);
  });

  it('deletes the copy when a save leaves no override', async () => {
    const loaded = await save(MOD, { base: 'BASE PROMPT' }, null);
    expect(await save(MOD, {}, loaded!.updatedAt)).toBeNull();
    expect(await getWorkingCopy(MOD)).toBeNull();
  });

  it('refuses an emptying save that is stale', async () => {
    const loaded = await save(MOD, { base: 'BASE 1' }, null);
    await save(MOD, { base: 'BASE 2' }, loaded!.updatedAt);
    await expect(save(MOD, {}, loaded!.updatedAt)).rejects.toThrow(DraftConflictError);
    expect((await getWorkingCopy(MOD))?.prompts).toEqual({ base: 'BASE 2' });
  });

  it('discard removes only my copy', async () => {
    await save(MOD, { base: 'MINE' }, null);
    await save(OTHER_MOD, { base: 'THEIRS' }, null);
    await discardWorkingCopy(MOD);
    expect(await getWorkingCopy(MOD)).toBeNull();
    expect((await getWorkingCopy(OTHER_MOD))?.prompts).toEqual({ base: 'THEIRS' });
  });

  it('is hidden from listDrafts unless asked for', async () => {
    const proposed = await newDraft();
    const working = await save(MOD, { base: 'BASE PROMPT' }, null);
    expect((await listDrafts()).map((d) => d.id)).toEqual([proposed.id]);
    expect((await listDrafts({ includeWorking: true })).map((d) => d.id).sort()).toEqual(
      [proposed.id, working!.id].sort()
    );
  });

  it('cannot be edited through updateDraft', async () => {
    const working = await save(MOD, { base: 'BASE PROMPT' }, null);
    await expect(
      updateDraft(
        working!.id,
        { prompts: { base: 'OTHER' }, note: null, expectedUpdatedAt: working!.updatedAt },
        OTHER_MOD
      )
    ).rejects.toThrow(DraftNotFoundError);
    expect((await getWorkingCopy(MOD))?.prompts).toEqual({ base: 'BASE PROMPT' });
  });
});

describe('proposeWorkingCopy', () => {
  it('turns my copy into a named proposed draft, and the next edit starts a fresh copy', async () => {
    const working = await saveWorkingCopy(MOD, { 'label:scam': 'SCAM DEF' }, null);
    const proposed = await proposeWorkingCopy(
      MOD,
      'tighter scam',
      'catches gift cards',
      working!.updatedAt
    );
    expect(proposed).toMatchObject({
      id: working!.id,
      kind: 'proposed',
      name: 'tighter scam',
      note: 'catches gift cards',
      prompts: { 'label:scam': 'SCAM DEF' },
    });
    expect(await getWorkingCopy(MOD)).toBeNull();
    expect((await listDrafts()).map((d) => d.id)).toEqual([working!.id]);

    const fresh = await saveWorkingCopy(MOD, { base: 'BASE PROMPT' }, null);
    expect(fresh!.id).not.toBe(working!.id);
  });

  it('refuses when I have no changes', async () => {
    const theirs = await saveWorkingCopy(OTHER_MOD, { base: 'THEIRS' }, null);
    await expect(proposeWorkingCopy(MOD, 'x', null, theirs!.updatedAt)).rejects.toThrow(
      /no changes to propose/
    );
  });

  it('refuses a blank or over-long name without proposing', async () => {
    const working = await saveWorkingCopy(MOD, { base: 'BASE PROMPT' }, null);
    await expect(proposeWorkingCopy(MOD, '  ', null, working!.updatedAt)).rejects.toThrow(
      DraftValidationError
    );
    await expect(proposeWorkingCopy(MOD, 'n'.repeat(101), null, working!.updatedAt)).rejects.toThrow(
      DraftValidationError
    );
    expect((await getWorkingCopy(MOD))?.kind).toBe('working');
  });
});

describe('proposeWorkingCopy — what the moderator saw', () => {
  it('refuses a copy saved again since (another tab), without proposing', async () => {
    const seen = await saveWorkingCopy(MOD, { base: 'SEEN' }, null);
    await saveWorkingCopy(MOD, { base: 'OTHER TAB' }, seen!.updatedAt);
    await expect(proposeWorkingCopy(MOD, 'x', null, seen!.updatedAt)).rejects.toThrow(
      DraftConflictError
    );
    expect((await getWorkingCopy(MOD))?.kind).toBe('working');
  });

  it('stores a blank note as no note', async () => {
    const working = await saveWorkingCopy(MOD, { base: 'BASE PROMPT' }, null);
    expect((await proposeWorkingCopy(MOD, 'x', '   ', working!.updatedAt)).note).toBeNull();
  });
});

describe("another moderator's working copy", () => {
  it('is invisible to getVisibleDraft, while proposed drafts and my own copy are not', async () => {
    const theirs = await saveWorkingCopy(OTHER_MOD, { base: 'THEIRS' }, null);
    const mine = await saveWorkingCopy(MOD, { base: 'MINE' }, null);
    const proposed = await newDraft();
    expect(await getVisibleDraft(theirs!.id, MOD)).toBeNull();
    expect(await getVisibleDraft(mine!.id, MOD)).toEqual(mine);
    expect(await getVisibleDraft(proposed.id, OTHER_MOD)).toEqual(proposed);
  });

  it('cannot be marked published by me, and stays theirs', async () => {
    const theirs = await saveWorkingCopy(OTHER_MOD, { base: 'THEIRS' }, null);
    await expect(
      markPublished(theirs!.id, { base: 51 }, theirs!.updatedAt, AS_MOD)
    ).rejects.toThrow(DraftNotFoundError);
    expect(await getWorkingCopy(OTHER_MOD)).toEqual(theirs);
  });
});

describe('publishing a working copy', () => {
  it('marks it published and frees the slot for a fresh copy', async () => {
    const working = await saveWorkingCopy(MOD, { base: 'BASE PROMPT' }, null);
    const published = await markPublished(working!.id, { base: 51 }, working!.updatedAt, {
      userId: MOD,
      workingName: 'stricter base',
    });
    expect(published).toMatchObject({
      id: working!.id,
      kind: 'proposed',
      name: 'stricter base',
      publishedPromptIds: { base: 51 },
    });
    expect(published.publishedAt).toBeInstanceOf(Date);
    expect(await getWorkingCopy(MOD)).toBeNull();

    const fresh = await saveWorkingCopy(MOD, { base: 'NEXT' }, null);
    expect(fresh!.id).not.toBe(working!.id);
  });
});

describe('schema upgrade', () => {
  it('adds kind to a table created before working copies, as proposed, and allows one copy each', async () => {
    holder.pg = await PGlite.create();
    await holder.pg.exec(`
      CREATE TABLE text_scan_prompt_draft (
        id bigserial PRIMARY KEY,
        name text NOT NULL,
        prompts jsonb NOT NULL DEFAULT '{}'::jsonb,
        note text,
        created_by integer NOT NULL,
        created_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds', now()),
        updated_by integer NOT NULL,
        updated_at timestamptz(3) NOT NULL DEFAULT date_trunc('milliseconds', now()),
        published_at timestamptz,
        published_prompt_ids jsonb
      );
      INSERT INTO text_scan_prompt_draft (name, created_by, updated_by) VALUES ('old', ${MOD}, ${MOD});
    `);
    await holder.pg.exec(SCHEMA);
    await holder.pg.exec(SCHEMA);

    expect((await listDrafts()).map((d) => [d.name, d.kind])).toEqual([['old', 'proposed']]);
    const copy = await saveWorkingCopy(MOD, { base: 'BASE PROMPT' }, null);
    expect(copy?.kind).toBe('working');
    await expect(saveWorkingCopy(MOD, { base: 'SECOND' }, null)).rejects.toThrow(
      DraftConflictError
    );
  });
});
