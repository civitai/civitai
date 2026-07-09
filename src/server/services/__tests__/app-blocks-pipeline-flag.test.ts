import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Decision 1 — dedicated PIPELINE flag.
 *
 * `isAppBlocksPipelineEnabled()` is the global (no-user) gate the build/publish
 * webhooks (`build-callback`, `git-push`, `workflow-completed`) use. It MUST:
 *   - evaluate the `app-blocks-pipeline-enabled` flag key (NOT the user-facing
 *     `app-blocks-enabled` flag) — proving the pipeline is decoupled from the
 *     mod-segmented user feature;
 *   - eval GLOBALLY (no user context), mirroring how the machine webhooks have
 *     always called Flipt;
 *   - be FAIL-SAFE: when the pipeline flag is absent / off (the as-merged state,
 *     since the flag is created in Flipt only AFTER this lands) it resolves
 *     `false` → the pipeline stays dark.
 *
 * `isFlipt` is mocked PER-KEY so the assertions can prove the helper reads the
 * pipeline key and ignores the user flag's state.
 */

const { mockIsFlipt } = vi.hoisted(() => ({ mockIsFlipt: vi.fn() }));

vi.mock('~/server/flipt/client', () => ({
  isFlipt: mockIsFlipt,
}));

import { isAppBlocksPipelineEnabled, APP_BLOCKS_PIPELINE_FLAG } from '../app-blocks-flag';

// Per-key Flipt stand-in. Only `app-blocks-pipeline-enabled` can turn the
// pipeline on; `app-blocks-enabled` (the user flag) being on must NOT leak in.
function perKeyFlipt(state: { pipeline: boolean; user: boolean }) {
  return async (flag: string): Promise<boolean> => {
    if (flag === 'app-blocks-pipeline-enabled') return state.pipeline;
    if (flag === 'app-blocks-enabled') return state.user;
    return false; // unknown / absent flag → false (matches real isFlipt)
  };
}

beforeEach(() => {
  mockIsFlipt.mockReset();
});

describe('isAppBlocksPipelineEnabled — Decision 1 pipeline gate', () => {
  it('exports the dedicated pipeline flag key', () => {
    expect(APP_BLOCKS_PIPELINE_FLAG).toBe('app-blocks-pipeline-enabled');
  });

  it('reads the pipeline flag key with a GLOBAL eval (no user context)', async () => {
    mockIsFlipt.mockImplementation(perKeyFlipt({ pipeline: true, user: false }));
    await expect(isAppBlocksPipelineEnabled()).resolves.toBe(true);
    // Only the flag key — entityId + context fall back to client.ts globals.
    expect(mockIsFlipt).toHaveBeenCalledWith('app-blocks-pipeline-enabled');
    expect(mockIsFlipt).toHaveBeenCalledTimes(1);
    // It must NEVER read the user-facing flag.
    expect(mockIsFlipt).not.toHaveBeenCalledWith(
      'app-blocks-enabled',
      expect.anything(),
      expect.anything()
    );
  });

  it('stays OFF when ONLY the user-facing flag is on (decoupled — no leak)', async () => {
    // Pipeline flag off, user flag on. The pipeline gate must still refuse.
    mockIsFlipt.mockImplementation(perKeyFlipt({ pipeline: false, user: true }));
    await expect(isAppBlocksPipelineEnabled()).resolves.toBe(false);
  });

  it('FAIL-SAFE: resolves false when the pipeline flag is absent (isFlipt → false)', async () => {
    // Simulate a missing flag / unreachable Flipt: isFlipt returns false.
    mockIsFlipt.mockResolvedValue(false);
    await expect(isAppBlocksPipelineEnabled()).resolves.toBe(false);
  });
});
