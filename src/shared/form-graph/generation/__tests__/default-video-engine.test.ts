import { describe, expect, it } from 'vitest';
import { generationHub } from '../hub.graph';
import { reconcileSelectors } from '../reconcile';
import type { GenerationCtx } from '~/shared/generation/context';

/**
 * 🔴 H3 is the platform's default video engine under a commercial commitment with a fixed
 * term. ASK JUSTIN BEFORE CHANGING IT — the reason to leave it alone is not visible
 * anywhere in this codebase, which is why it is pinned here.
 */

const EXT: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

// No `ecosystem` — a browser with nothing stored for the video output.
const FRESH = { output: 'video', workflow: 'txt2vid', prompt: 'a cat' };

describe('default video engine', () => {
  it('resolves to MiniMaxH3', () => {
    const result = generationHub.parse(reconcileSelectors(FRESH).raw, EXT);
    expect(result.success).toBe(true);
    expect((result as { data: { ecosystem?: string } }).data.ecosystem).toBe('MiniMaxH3');
  });
});
