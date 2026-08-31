import { vi, describe, it, expect, beforeEach } from 'vitest';

import { assertSharedTextSafe, SharedContentBlockedError } from '../shared-content-safety';

const throwOnBlockedUserContent = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]): Promise<void> => undefined)
);
vi.mock('~/server/services/blocklist.service', () => ({ throwOnBlockedUserContent }));
vi.mock('~/utils/metadata/audit', () => ({
  includesMinor: () => false,
  includesPoi: () => false,
}));
vi.mock('~/server/services/orchestrator/promptAuditing', () => ({
  auditPromptServer: vi.fn(async () => ({ success: true })),
}));

/**
 * The block CATEGORY, not the block. `assertSharedTextSafe` is the one consumer that classifies a
 * blocklist rejection, and the router reads that category to decide whether to file a Report — so
 * flattening the two lists into one category here is a change to what gets reported, not a
 * cosmetic one.
 *
 * The suite that already covers this path mocks the guard with a bare `Error`, which exercises
 * neither the `onBlocked` classification nor the rethrow that keeps it intact. That is the gap
 * this file closes: without it, an edit collapsing 'pattern' back into 'link' fails nothing.
 */
describe('assertSharedTextSafe — how a blocklist rejection is classified', () => {
  const input = { title: 'A listing', body: 'some text', userId: 1 };

  beforeEach(() => {
    vi.clearAllMocks();
    throwOnBlockedUserContent.mockResolvedValue(undefined);
  });

  const blockWith = (kind: 'link' | 'pattern') =>
    throwOnBlockedUserContent.mockImplementation(
      async (_content: unknown, options: { onBlocked?: (k: string) => never }) => {
        options.onBlocked?.(kind);
      }
    );

  it.each([
    ['link', 'link'],
    ['pattern', 'pattern'],
  ] as const)('reports a %s hit as category %s', async (kind, expected) => {
    blockWith(kind);

    const error = await assertSharedTextSafe(input).catch((e) => e);

    expect(error).toBeInstanceOf(SharedContentBlockedError);
    expect((error as SharedContentBlockedError).category).toBe(expected);
  });

  /**
   * The guard reaches redis and Flipt. An infrastructure failure must not escape as a raw 500 on
   * user input — but it must also not be mistaken for a content block that the router would then
   * act on. It is reported as a block, deliberately: refusing the write is the safe direction when
   * we cannot tell whether the text is clean.
   */
  it('does not let an infrastructure failure escape unwrapped', async () => {
    throwOnBlockedUserContent.mockRejectedValue(new Error('redis unreachable'));

    const error = await assertSharedTextSafe(input).catch((e) => e);

    expect(error).toBeInstanceOf(SharedContentBlockedError);
  });
});
