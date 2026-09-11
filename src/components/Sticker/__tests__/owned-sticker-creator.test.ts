// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CosmeticsUtil from '~/components/Cosmetics/cosmetics.util';

/**
 * 🔴 THE FIELD MUST SURVIVE THE HOOK, AND NOTHING ELSE CHECKS THAT.
 *
 * The tray's "Made by you" filter exists without a query because `createdById`
 * rides along on `user.getCosmetics`. Every test of the filter itself mocks
 * `useOwnedSticker` away and hands the field in by hand, so the one layer that
 * actually carries it — this `map` — is the layer those tests cannot see.
 * Delete `createdById` from the projection in `sticker.util.ts` and every tray
 * test still passes; only this file goes red.
 *
 * It also pins the two-state contract the type comment claims: `null` is a
 * staff-authored cosmetic, `undefined` is not-fetched. Collapsing them would
 * make a stranger's sticker indistinguishable from an unfetched one.
 */
const mocks = vi.hoisted(() => ({
  sticker: [] as Record<string, unknown>[],
}));

vi.mock('~/components/Cosmetics/cosmetics.util', async (importOriginal) => ({
  ...(await importOriginal<typeof CosmeticsUtil>()),
  useQueryUserCosmetics: () => ({ data: { sticker: mocks.sticker }, isLoading: false }),
}));

import { useOwnedSticker } from '~/components/Sticker/sticker.util';
import type { ResolvedSticker } from '~/components/Sticker/sticker.util';

/** No @testing-library/react in this repo, so the hook is read off a probe. */
const readOwnedSticker = async () => {
  let captured: ResolvedSticker[] = [];
  const Probe = () => {
    captured = useOwnedSticker().sticker;
    return null;
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => {
    createRoot(container).render(createElement(Probe));
  });
  return captured;
};

const owned = (id: number, createdById: number | null | undefined, obtainedAt: string) => ({
  id,
  name: `Sticker ${id}`,
  data: { slug: `slug-${id}`, url: `https://example.test/${id}.png` },
  obtainedAt: new Date(obtainedAt),
  ...(createdById === undefined ? {} : { createdById }),
});

beforeEach(() => {
  mocks.sticker = [];
  document.body.innerHTML = '';
});

describe('useOwnedSticker carries the creator through', () => {
  it('keeps createdById on every resolved sticker', async () => {
    mocks.sticker = [
      owned(1, 7, '2026-01-03T00:00:00.000Z'),
      owned(2, 999, '2026-01-02T00:00:00.000Z'),
    ];

    const sticker = await readOwnedSticker();

    // Named per id rather than counted, so dropping the field fails saying which
    // sticker lost its creator instead of "expected undefined to be 7".
    expect(sticker.map((s) => [s.id, s.createdById])).toEqual([
      [1, 7],
      [2, 999],
    ]);
  });

  it('distinguishes a staff-authored null from an unfetched undefined', async () => {
    mocks.sticker = [
      owned(1, null, '2026-01-03T00:00:00.000Z'),
      owned(2, undefined, '2026-01-02T00:00:00.000Z'),
    ];

    const [staff, unfetched] = await readOwnedSticker();
    expect(staff.createdById).toBeNull();
    expect(unfetched.createdById).toBeUndefined();
  });

  it('survives the newest-first sort and the one-tile-per-sticker dedupe', async () => {
    // Same sticker held twice — the survivor must be the newest holding AND keep
    // its creator, since `uniqBy` picks a row rather than merging them.
    mocks.sticker = [
      owned(5, 7, '2026-01-01T00:00:00.000Z'),
      owned(5, 7, '2026-02-01T00:00:00.000Z'),
      owned(6, 42, '2026-01-15T00:00:00.000Z'),
    ];

    const sticker = await readOwnedSticker();

    expect(sticker.map((s) => [s.id, s.createdById])).toEqual([
      [5, 7],
      [6, 42],
    ]);
  });
});
