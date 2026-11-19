import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

/**
 * Where each reader's content level comes from (`doc-levels.ts`), as LITERAL bit sets (PG 1,
 * PG-13 2, R 4, X 8, XXX 16, Blocked 32), and how the flag decides whether the store applies it.
 */

const flags = vi.hoisted(() => ({ on: new Set<string>(), calls: [] as unknown[][] }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  readFliptBoolean: async (flag: string, entityId?: string, context?: unknown) => {
    flags.calls.push([flag, entityId, context]);
    return flags.on.has(`${flag}@${entityId}`);
  },
}));

import {
  audienceDocLevel,
  domainDocLevel,
  isSharedDocLevelsOn,
  viewerDocLevel,
  withDocLevelGate,
} from '~/server/services/apps/doc-levels';
import type { StorageAccess } from '~/server/services/apps/doc-store-access';

const FLAG = 'app-blocks-shared-doc-levels';

beforeEach(() => {
  flags.on.clear();
  flags.calls.length = 0;
});

describe('audienceDocLevel — the registry feed’s level per audience', () => {
  it.each([
    [{ r: false, x: false, xxx: false }, 3],
    [{ r: true, x: false, xxx: false }, 7],
    [{ r: false, x: true, xxx: false }, 11],
    [{ r: true, x: true, xxx: false }, 15],
    // XXX (16) only with `xxx`.
    [{ r: true, x: true, xxx: true }, 31],
    [{ r: false, x: false, xxx: true }, 19],
  ])('%j → %i', (allowed, level) => {
    expect(audienceDocLevel(allowed)).toBe(level);
  });
});

describe('viewerDocLevel — a block token reader’s level', () => {
  it.each([
    // Domain ceiling ∩ the viewer's own level.
    [{ maxBrowsingLevel: 31, viewerBrowsingLevel: 7 }, 7],
    [{ maxBrowsingLevel: 3, viewerBrowsingLevel: 31 }, 3],
    [{ maxBrowsingLevel: 28, viewerBrowsingLevel: 12 }, 12],
    // Blocked is never a selectable level.
    [{ maxBrowsingLevel: 63, viewerBrowsingLevel: 63 }, 31],
    // Fails closed to PG: no ceiling, or nothing in common.
    [{ viewerBrowsingLevel: 31 }, 1],
    [{ maxBrowsingLevel: 24, viewerBrowsingLevel: 3 }, 1],
    // No PG-13 floor: these are other people's documents.
    [{ maxBrowsingLevel: 31, viewerBrowsingLevel: 1 }, 1],
  ])('%j → %i', (claims, level) => {
    expect(viewerDocLevel(claims)).toBe(level);
  });
});

describe('domainDocLevel — the cap on an author’s own rated documents', () => {
  it.each<[{ maxBrowsingLevel?: number; viewerBrowsingLevel?: number }, number]>([
    // The domain ceiling alone: the viewer's own setting is not read.
    [{ maxBrowsingLevel: 31, viewerBrowsingLevel: 1 }, 31],
    [{ maxBrowsingLevel: 3, viewerBrowsingLevel: 31 }, 3],
    [{ maxBrowsingLevel: 28 }, 28],
    // Blocked is never a selectable level.
    [{ maxBrowsingLevel: 63 }, 31],
    // Fails closed to PG.
    [{ viewerBrowsingLevel: 31 }, 1],
    [{ maxBrowsingLevel: 32 }, 1],
  ])('%j → %i', (claims, level) => {
    expect(domainDocLevel(claims)).toBe(level);
  });
});

describe('the flag decides whether the gate is applied, per app', () => {
  const access = (appId: string) =>
    ({ ctx: { appId, ns: 'prod', viewerUid: 9 } } as unknown as StorageAccess);

  it('off: the access is returned unchanged (the same object)', async () => {
    const a = access('ab_OFFAPP');
    expect(await withDocLevelGate(a, { maxBrowsingLevel: 31, viewerBrowsingLevel: 7 })).toBe(a);
    expect(await isSharedDocLevelsOn('ab_OFFAPP')).toBe(false);
  });

  it('on: the context carries the viewer’s level; evaluated per app with no context', async () => {
    flags.on.add(`${FLAG}@ab_ONAPP`);
    const gated = await withDocLevelGate(access('ab_ONAPP'), {
      maxBrowsingLevel: 31,
      viewerBrowsingLevel: 6,
    });
    expect(gated.ctx).toEqual({
      appId: 'ab_ONAPP',
      ns: 'prod',
      viewerUid: 9,
      levels: { viewerLevel: 6, domainLevel: 31 },
    });
    expect(await isSharedDocLevelsOn('ab_ONAPP')).toBe(true);
    expect(flags.calls).toEqual([
      [FLAG, 'ab_ONAPP', undefined],
      [FLAG, 'ab_ONAPP', undefined],
    ]);
  });
});
