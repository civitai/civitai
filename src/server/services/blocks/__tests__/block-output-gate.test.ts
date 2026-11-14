import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import {
  deriveOutputGate,
  type BlockOutputGateItem,
} from '~/server/services/blocks/block-output-gate';
import {
  allBrowsingLevelsFlag,
  publicBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';

const OWNER = 7;
const item = (over: Partial<BlockOutputGateItem> = {}): BlockOutputGateItem => ({
  mediaType: 'video',
  nsfwLevel: 'pg',
  blockedReason: null,
  neverRatedVideoStep: false,
  privateGen: false,
  ownerId: OWNER,
  ...over,
});
const pgViewer = { userId: 99, browsingLevel: publicBrowsingLevelsFlag };
const allViewer = { userId: 99, browsingLevel: allBrowsingLevelsFlag };
const owner = { userId: OWNER, browsingLevel: allBrowsingLevelsFlag };

describe('deriveOutputGate', () => {
  it('CONTROL: a rated PG clip is visible to a PG viewer', () => {
    expect(deriveOutputGate(item(), pgViewer)).toEqual({
      state: 'visible',
      nsfwLevel: NsfwLevel.PG,
    });
  });

  it('an orchestrator block hides the clip even when it reads available and PG', () => {
    // The videoGen shape: `available: true`, a PG level, and a block reason set.
    for (const blockedReason of ['csam', 'minor', 'Blocked']) {
      expect(deriveOutputGate(item({ blockedReason, nsfwLevel: 'pg' }), allViewer)).toEqual({
        state: 'hidden',
        reason: 'blocked',
      });
      expect(deriveOutputGate(item({ blockedReason, nsfwLevel: 'pg' }), owner)).toEqual({
        state: 'hidden',
        reason: 'blocked',
      });
    }
  });

  it("treats blockedReason 'none' as not blocked", () => {
    expect(deriveOutputGate(item({ blockedReason: 'none' }), pgViewer).state).toBe('visible');
  });

  it('an unscanned clip is pending, never visible', () => {
    expect(deriveOutputGate(item({ nsfwLevel: null }), allViewer)).toEqual({ state: 'pending' });
  });

  it('a clip above the viewer level is hidden; the same clip shows to an all-levels viewer', () => {
    expect(deriveOutputGate(item({ nsfwLevel: 'r' }), pgViewer)).toEqual({
      state: 'hidden',
      reason: 'above_level',
    });
    expect(deriveOutputGate(item({ nsfwLevel: 'r' }), allViewer)).toEqual({
      state: 'visible',
      nsfwLevel: NsfwLevel.R,
    });
  });

  it("reads 'na' as a verdict with no level (PG), case-insensitively", () => {
    expect(deriveOutputGate(item({ nsfwLevel: 'NA' }), pgViewer)).toEqual({
      state: 'visible',
      nsfwLevel: NsfwLevel.PG,
    });
    expect(deriveOutputGate(item({ nsfwLevel: 'XXX' }), allViewer)).toEqual({
      state: 'visible',
      nsfwLevel: NsfwLevel.XXX,
    });
  });

  it('refuses a rating it does not know instead of mapping it', () => {
    for (const nsfwLevel of ['g', 'blocked', 'pg-13', '', 'unknown']) {
      expect(deriveOutputGate(item({ nsfwLevel }), allViewer)).toEqual({
        state: 'hidden',
        reason: 'unknown_rating',
      });
    }
  });

  it('hides never-rated video ecosystems, even rated-looking and for the owner', () => {
    expect(deriveOutputGate(item({ neverRatedVideoStep: true }), owner)).toEqual({
      state: 'hidden',
      reason: 'unrated',
    });
    expect(deriveOutputGate(item({ neverRatedVideoStep: true, nsfwLevel: null }), owner)).toEqual({
      state: 'hidden',
      reason: 'unrated',
    });
  });

  it('serves audio, archives and non-GLB meshes to their owner only', () => {
    for (const mediaType of ['audio', 'archive', 'model3d'] as const) {
      const it = item({ mediaType, nsfwLevel: null, format: 'fbx' });
      expect(deriveOutputGate(it, owner).state).toBe('visible');
      expect(deriveOutputGate(it, allViewer)).toEqual({ state: 'hidden', reason: 'owner_only' });
    }
  });

  it('rates a GLB mesh by its preview render, and is owner-only without one', () => {
    const glb = { mediaType: 'model3d' as const, format: 'glb', nsfwLevel: null };
    expect(deriveOutputGate(item({ ...glb, previewNsfwLevel: 'r' }), pgViewer)).toEqual({
      state: 'hidden',
      reason: 'above_level',
    });
    expect(deriveOutputGate(item({ ...glb, previewNsfwLevel: 'pg' }), pgViewer).state).toBe(
      'visible'
    );
    expect(deriveOutputGate(item(glb), allViewer)).toEqual({
      state: 'hidden',
      reason: 'owner_only',
    });
  });

  it('a private mature generation shows to its owner only', () => {
    const priv = item({ privateGen: true, nsfwLevel: 'x' });
    expect(deriveOutputGate(priv, allViewer)).toEqual({ state: 'hidden', reason: 'private' });
    expect(deriveOutputGate(priv, owner).state).toBe('visible');
    expect(deriveOutputGate(item({ privateGen: true }), pgViewer).state).toBe('visible');
  });

  it('an anonymous viewer is never the owner', () => {
    expect(
      deriveOutputGate(item({ mediaType: 'audio' }), {
        userId: null,
        browsingLevel: allBrowsingLevelsFlag,
      })
    ).toEqual({ state: 'hidden', reason: 'owner_only' });
  });
});
