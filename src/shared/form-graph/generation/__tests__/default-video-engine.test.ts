import { describe, expect, it } from 'vitest';
import { runOracle, type AnyRecord } from './differential';
import { generationHub } from '../hub.graph';
import { reconcileSelectors } from '../reconcile';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

/**
 * H3 is the platform's default video engine under a commercial commitment with a
 * fixed term. Ask Justin before changing it — the reason to leave it alone is not
 * visible anywhere in this codebase. Both graphs carry their own copy of the
 * per-output default, so both are pinned here.
 */

const EXT: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

// no `ecosystem` — a browser with nothing in `generation-graph.output.video`
const FRESH: AnyRecord = { output: 'video', workflow: 'txt2vid', prompt: 'a cat' };

describe('default video engine', () => {
  it('resolves to MiniMaxH3 in the live graph', () => {
    const result = runOracle(FRESH, EXT);
    expect(result.success).toBe(true);
    expect(result.data.ecosystem).toBe('MiniMaxH3');
  });

  it('resolves to MiniMaxH3 in the ported graph', () => {
    const result = generationHub.parse(reconcileSelectors(FRESH).raw, EXT as never);
    expect(result.success).toBe(true);
    expect((result as { data: AnyRecord }).data.ecosystem).toBe('MiniMaxH3');
  });
});
