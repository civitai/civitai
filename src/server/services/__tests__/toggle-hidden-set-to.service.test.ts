import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  HiddenImages,
  HiddenModel3Ds,
  HiddenModels,
  toggleHidden,
} from '~/server/services/user-preferences.service';

/**
 * `toggleHidden` forwarded the caller's `hidden` only for `kind: 'user'`; image,
 * model and model3d got the id alone and blind-flipped off whatever row they found.
 * So an explicit un-hide of an unengaged entity CREATED a Hide, and an explicit hide
 * of an already-hidden one DELETED it — both the inverse of the request. Same defect
 * #4230 fixed for users, three tables over.
 *
 * Every in-app caller omits `hidden` (HideModelButton, HideImageButton,
 * HideModel3DButton), so the flip is the path the product actually uses and the
 * compatibility cases below are the ones that would break real behaviour.
 *
 * Every write is addressed by (user, entity, type) rather than by the PK, so the
 * assertions name the `type` filter: it is the only thing standing between a hide
 * and a Favorite or Mute a sibling writer established after this call's read.
 */

const userId = 42;
const id = 7;

const KINDS = [
  {
    kind: 'model' as const,
    delegate: dbMock.dbWrite.modelEngagement,
    cache: HiddenModels,
    scoped: { userId, modelId: id },
    created: { userId, modelId: id, type: 'Hide' },
  },
  {
    kind: 'image' as const,
    delegate: dbMock.dbWrite.imageEngagement,
    cache: HiddenImages,
    scoped: { userId, imageId: id },
    created: { userId, imageId: id, type: 'Hide' },
  },
  {
    kind: 'model3d' as const,
    delegate: dbMock.dbWrite.model3DEngagement,
    cache: HiddenModel3Ds,
    scoped: { userId, model3dId: id },
    created: { userId, model3dId: id, type: 'Hide' },
  },
];

const toggle = (kind: (typeof KINDS)[number]['kind'], hidden?: boolean) =>
  toggleHidden({ kind, data: [{ id }], hidden, userId } as Parameters<typeof toggleHidden>[0]);

describe.each(KINDS)('toggleHidden kind=$kind — honours the caller intent', (k) => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    k.delegate.findUnique.mockResolvedValue(null);
    k.delegate.create.mockResolvedValue({});
    k.delegate.updateMany.mockResolvedValue({ count: 1 });
    k.delegate.deleteMany.mockResolvedValue({ count: 1 });
    vi.spyOn(k.cache, 'refreshCache').mockResolvedValue(undefined);
  });

  // An un-hide issues its `type: 'Hide'` delete unconditionally — the row read may
  // already be gone or replaced, and the filter is what keeps that from mattering.
  // What it must never do is establish a Hide, so that is what these assert.
  const nothingHidden = () => {
    expect(k.delegate.create).not.toHaveBeenCalled();
    expect(k.delegate.updateMany).not.toHaveBeenCalled();
    expect(k.delegate.update).not.toHaveBeenCalled();
    expect(k.delegate.delete).not.toHaveBeenCalled();
    for (const [args] of k.delegate.deleteMany.mock.calls)
      expect(args).toEqual({ where: { ...k.scoped, type: 'Hide' } });
  };

  const noWrites = () => {
    nothingHidden();
    expect(k.delegate.deleteMany).not.toHaveBeenCalled();
  };

  // The three compatibility cases: every in-app caller omits `hidden`, so these are
  // the paths the product uses today and they must behave as they did before.
  it('omitted hidden on an unengaged entity still creates the Hide', async () => {
    await toggle(k.kind);

    expect(k.delegate.create).toHaveBeenCalledWith({ data: k.created });
  });

  it('omitted hidden on a hidden entity still deletes it', async () => {
    k.delegate.findUnique.mockResolvedValue({ type: 'Hide' });

    await toggle(k.kind);

    expect(k.delegate.deleteMany).toHaveBeenCalledWith({
      where: { ...k.scoped, type: 'Hide' },
    });
  });

  it('omitted hidden on a non-Hide row still converts it to Hide', async () => {
    k.delegate.findUnique.mockResolvedValue({ type: 'Favorite' });

    await toggle(k.kind);

    // Scoped to the type this call READ: an unqualified update passes a bare "was it
    // called" check and eats whatever type occupies the row by the time it lands.
    expect(k.delegate.updateMany).toHaveBeenCalledWith({
      where: { ...k.scoped, type: 'Favorite' },
      data: { type: 'Hide' },
    });
  });

  it('hidden=false on an unengaged entity establishes nothing and reports not hidden', async () => {
    await expect(toggle(k.kind, false)).resolves.toMatchObject({ hidden: false });

    nothingHidden();
  });

  it('hidden=false on a non-Hide row leaves that row alone — an un-hide must not hide', async () => {
    k.delegate.findUnique.mockResolvedValue({ type: 'Favorite' });

    await expect(toggle(k.kind, false)).resolves.toMatchObject({ hidden: false });

    nothingHidden();
  });

  it('hidden=true on an already-hidden entity leaves it hidden', async () => {
    k.delegate.findUnique.mockResolvedValue({ type: 'Hide' });

    await expect(toggle(k.kind, true)).resolves.toMatchObject({ hidden: true });

    // The bug this replaces: the blind flip DELETED the row here, so asking to hide
    // an already-hidden entity un-hid it.
    noWrites();
  });

  it('hidden=false on a hidden entity deletes it and reports not hidden', async () => {
    k.delegate.findUnique.mockResolvedValue({ type: 'Hide' });

    await expect(toggle(k.kind, false)).resolves.toMatchObject({ hidden: false });

    expect(k.delegate.deleteMany).toHaveBeenCalledWith({
      where: { ...k.scoped, type: 'Hide' },
    });
  });

  it('refreshes the hidden cache even on the no-write path', async () => {
    await toggle(k.kind, false);

    // The client drops its optimistic entry off the response; the server-side feed
    // filter reads this cache, so skipping it here would diverge the two.
    expect(k.cache.refreshCache).toHaveBeenCalledWith({ userId });
  });
});
