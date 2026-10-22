import { NsfwLevel } from '@civitai/orchestration-client';
import { describe, expect, it } from 'vitest';

import { getPolyGenPostBlock } from '~/server/orchestrator/polygen/polygen-output';

const fbx = { format: 'fbx' };
const glb = { format: 'glb' };
const block = (
  primaryModel: { format: string },
  effectiveNsfwLevel: NsfwLevel | undefined,
  allowMatureContent: boolean
) => getPolyGenPostBlock({ primaryModel, effectiveNsfwLevel, allowMatureContent });

describe('getPolyGenPostBlock', () => {
  // An FBX-only result has no preview render; an unrated one must not pass as safe.
  it('blocks an unrated FBX-only result', () => {
    expect(block(fbx, undefined, true)).toMatch(/rated yet/);
  });

  it('allows a rated FBX-only result', () => {
    expect(block(fbx, NsfwLevel.PG, false)).toBeUndefined();
  });

  it('blocks a mature result generated without mature-content billing', () => {
    expect(block(fbx, NsfwLevel.X, false)).toMatch(/Yellow Buzz/);
  });

  it('leaves an unrated GLB result to its preview render, as before', () => {
    expect(block(glb, undefined, false)).toBeUndefined();
  });
});
