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
  DraftPublishedError,
  DraftValidationError,
  createDraft,
  getDraft,
  listDrafts,
  markPublished,
  updateDraft,
} = await import('../text-scan-lab/drafts.service');

const MOD = 990001;
const OTHER_MOD = 990002;

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
    const published = await markPublished(draft.id, { 'label:scam': 41 }, draft.updatedAt);
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
    await expect(markPublished(draft.id, { 'label:scam': 41 }, draft.updatedAt)).rejects.toThrow(
      DraftConflictError
    );
  });

  it('refuses to publish twice', async () => {
    const draft = await newDraft();
    await markPublished(draft.id, { 'label:scam': 41 }, draft.updatedAt);
    await expect(markPublished(draft.id, { 'label:scam': 42 }, draft.updatedAt)).rejects.toThrow(
      DraftPublishedError
    );
  });
});
