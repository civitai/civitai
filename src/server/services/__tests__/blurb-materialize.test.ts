import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as FliptClient from '~/server/flipt/client';

const dbRead = dbMock.dbRead;
const dbWrite = dbMock.dbWrite;

// Hoisted: blurb-materialize.service reads the flag on its first statement, so the factory
// below has to exist before the service module is imported.
const { isFlipt } = vi.hoisted(() => ({ isFlipt: vi.fn() }));

// Without this the suite evaluates the REAL flag, which is default-off — every expandBlurbs
// test would then assert against the early return rather than the expansion it names.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  isFlipt,
}));

// Do NOT add a direct mock of the db client module — `dbMock` is registered globally in
// src/__tests__/setup.ts (the canonical mock) and a local mock of that module conflicts with it.
const { expandBlurbs, reconcileBlurbReferences } = await import(
  '~/server/services/blurb-materialize.service'
);

beforeEach(() => {
  vi.clearAllMocks();
  isFlipt.mockResolvedValue(true);
  dbRead.blurbReference.findMany.mockResolvedValue([]);
});

describe('expandBlurbs', () => {
  it('replaces span content with the blurb row, ignoring what the client sent', async () => {
    dbRead.blurb.findMany.mockResolvedValue([{ id: 7, contentHash: 'h7', content: 'REAL' }]);
    const { html } = await expandBlurbs({
      userId: 10,
      html: '<span data-type="blurb" data-id="7">ATTACKER SUPPLIED</span>',
    });
    expect(html).toBe('<span data-type="blurb" data-id="7">REAL</span>');
  });

  it('unwraps a span whose blurb belongs to another user', async () => {
    // The ownership filter is in the query, so a foreign blurb simply does not come back.
    dbRead.blurb.findMany.mockResolvedValue([]);
    const { html, uses } = await expandBlurbs({
      userId: 10,
      html: '<p>x</p><span data-type="blurb" data-id="99">someone elses</span>',
    });
    expect(html).toBe('<p>x</p>someone elses');
    expect(uses).toEqual([]);
  });

  it('scopes the lookup to the saving user and to live blurbs', async () => {
    dbRead.blurb.findMany.mockResolvedValue([]);
    await expandBlurbs({ userId: 10, html: '<span data-type="blurb" data-id="7">x</span>' });
    expect(dbRead.blurb.findMany).toHaveBeenCalledWith({
      where: { id: { in: [7] }, userId: 10, deletedAt: null },
      select: { id: true, content: true, contentHash: true },
    });
  });

  it('reports one use per distinct blurb, with its hash', async () => {
    dbRead.blurb.findMany.mockResolvedValue([{ id: 7, contentHash: 'h7', content: 'A' }]);
    const { uses } = await expandBlurbs({
      userId: 10,
      html: '<span data-type="blurb" data-id="7">x</span><span data-type="blurb" data-id="7">y</span>',
    });
    expect(uses).toEqual([{ blurbId: 7, contentHash: 'h7' }]);
  });

  it('does not query at all when the html has no blurb spans', async () => {
    const { html, uses } = await expandBlurbs({ userId: 10, html: '<p>plain</p>' });
    expect(html).toBe('<p>plain</p>');
    expect(uses).toEqual([]);
    expect(dbRead.blurb.findMany).not.toHaveBeenCalled();
  });

  it('reports NOT EVALUATED, with the html untouched, when the flag is off for the owner', async () => {
    isFlipt.mockResolvedValue(false);
    const html = '<span data-type="blurb" data-id="7">CLIENT TEXT</span>';

    const result = await expandBlurbs({ userId: 10, html });

    // `evaluated: false` and NO `uses` key. Returning `uses: []` here is the bug this shape
    // exists to make unrepresentable: a caller would hand it to reconcileBlurbReferences and
    // delete every reference row the owner has.
    expect(result).toEqual({ evaluated: false, html });
    expect('uses' in result).toBe(false);
    expect(dbRead.blurb.findMany).not.toHaveBeenCalled();
    // Keyed on the OWNER, so a rollout is sticky per creator rather than per save.
    expect(isFlipt).toHaveBeenCalledWith('text-blurbs', '10');
  });

  it('distinguishes "no blurbs in this content" from "flag off" — the first IS evaluated', async () => {
    // The pair is the point. Both leave the html alone; only this one may reconcile.
    const html = '<p>plain</p>';

    isFlipt.mockResolvedValue(true);
    expect(await expandBlurbs({ userId: 10, html })).toEqual({ evaluated: true, html, uses: [] });

    isFlipt.mockResolvedValue(false);
    expect(await expandBlurbs({ userId: 10, html })).toEqual({ evaluated: false, html });
  });

  it('resolves one span and unwraps another in the same document, on both sides of it', async () => {
    dbRead.blurb.findMany.mockResolvedValue([{ id: 7, contentHash: 'h7', content: 'REAL' }]);
    const { html, uses } = await expandBlurbs({
      userId: 10,
      html:
        '<p>a</p><span data-type="blurb" data-id="99">orphan-before</span>' +
        '<span data-type="blurb" data-id="7">ATTACKER</span>' +
        '<span data-type="blurb" data-id="99">orphan-after</span><p>b</p>',
    });
    expect(html).toBe(
      '<p>a</p>orphan-before<span data-type="blurb" data-id="7">REAL</span>orphan-after<p>b</p>'
    );
    expect(uses).toEqual([{ blurbId: 7, contentHash: 'h7' }]);
  });
});

describe('reconcileBlurbReferences', () => {
  it('removes rows for blurbs no longer present in the content', async () => {
    dbRead.blurbReference.findMany.mockResolvedValue([{ blurbId: 5 }, { blurbId: 7 }]);
    await reconcileBlurbReferences({
      entityType: 'Article',
      entityId: 1,
      uses: [{ blurbId: 7, contentHash: 'h7' }],
    });
    expect(dbWrite.blurbReference.deleteMany).toHaveBeenCalledWith({
      where: { entityType: 'Article', entityId: 1, blurbId: { in: [5] } },
    });
  });

  it('upserts a row per current use', async () => {
    await reconcileBlurbReferences({
      entityType: 'Article',
      entityId: 1,
      uses: [{ blurbId: 7, contentHash: 'h7' }],
    });
    expect(dbWrite.blurbReference.upsert).toHaveBeenCalledTimes(1);
    const call = dbWrite.blurbReference.upsert.mock.calls[0][0];
    expect(call.where).toEqual({
      blurbId_entityType_entityId: { blurbId: 7, entityType: 'Article', entityId: 1 },
    });
    expect(call.create.materializedHash).toBe('h7');
    expect(call.update.materializedHash).toBe('h7');
  });

  it('still deletes when uses is empty — the last blurb was removed from the content', async () => {
    // The tempting shortcut for the flag-off case is to make this function a no-op on an empty
    // `uses`. It would break exactly this: removing an entity's last blurb legitimately produces
    // an empty `uses` and MUST drop the rows. The flag-off case is handled at the call site,
    // which does not call this function at all.
    dbRead.blurbReference.findMany.mockResolvedValue([{ blurbId: 5 }, { blurbId: 7 }]);
    await reconcileBlurbReferences({ entityType: 'Article', entityId: 1, uses: [] });

    expect(dbWrite.blurbReference.deleteMany).toHaveBeenCalledWith({
      where: { entityType: 'Article', entityId: 1, blurbId: { in: [5, 7] } },
    });
    expect(dbWrite.blurbReference.upsert).not.toHaveBeenCalled();
  });

  it('skips the delete entirely when nothing needs removing', async () => {
    dbRead.blurbReference.findMany.mockResolvedValue([{ blurbId: 7 }]);
    await reconcileBlurbReferences({
      entityType: 'Article',
      entityId: 1,
      uses: [{ blurbId: 7, contentHash: 'h7' }],
    });
    expect(dbWrite.blurbReference.deleteMany).not.toHaveBeenCalled();
  });
});
