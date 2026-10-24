import { vi, describe, it, expect, beforeEach } from 'vitest';

import { isEscalatedServerFault } from '~/server/logging/server-fault-override';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { assertSharedTextSafe, SharedContentBlockedError } from '../shared-content-safety';

const throwOnBlockedUserContent = vi.hoisted(() =>
  vi.fn(async (..._a: unknown[]): Promise<void> => undefined)
);
const getBlocklistData = vi.hoisted(() => vi.fn(async (..._a: unknown[]): Promise<string[]> => []));
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedUserContent,
  getBlocklistData,
}));
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
    getBlocklistData.mockResolvedValue([]);
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
   * Pins the ARGUMENT, not just the outcome. The guard scans values separately so a pattern
   * cannot match across the boundary between two independent fields, and handing it the two
   * fields already joined into one string silently reinstates exactly that. Nothing else here
   * notices — the mock swallows whatever it is given — so that revert passed every test.
   */
  it('hands the guard the fields separately, not pre-joined', async () => {
    await assertSharedTextSafe(input);

    expect(throwOnBlockedUserContent).toHaveBeenCalledWith(
      [input.title, input.body],
      expect.objectContaining({ surface: 'appSharedStorage' })
    );
  });

  /**
   * Reading the two lists takes no caller input, so a failure there is our outage. It is still
   * refused — refusing is the safe direction when we cannot tell whether the text is clean — but
   * escalated to a server fault (which the shared write budget refunds instead of charging) and
   * says to retry rather than claiming a blocked link. The guard is never reached.
   */
  it('refuses a failed list read, escalated as our fault with a retry message', async () => {
    getBlocklistData.mockRejectedValue(new Error('redis unreachable'));

    const error = await assertSharedTextSafe(input).catch((e) => e);

    expect(error).toBeInstanceOf(SharedContentBlockedError);
    expect(isEscalatedServerFault(error)).toBe(true);
    expect((error as SharedContentBlockedError).category).toBe('link');
    expect((error as SharedContentBlockedError).message).toBe(
      'Content could not be reviewed right now. Please try again.'
    );
    expect(throwOnBlockedUserContent).not.toHaveBeenCalled();
  });

  it('reads exactly the link-domain and message-pattern lists before the guard', async () => {
    await assertSharedTextSafe(input);

    expect(getBlocklistData.mock.calls.map(([type]) => type).sort()).toEqual([
      'LinkDomain',
      'MessagePattern',
    ]);
  });

  /**
   * The guard scans CALLER text. With the lists already proven readable, a non-block throw from it
   * is either a race or a scan bug a crafted input could trigger, so it must be charged: escalating
   * it would hand the caller an unbounded run of free moderation calls. Still refused with the
   * retry message, never a raw 500.
   */
  it('refuses a non-block guard throw WITHOUT escalating it, so it is charged', async () => {
    throwOnBlockedUserContent.mockRejectedValue(new TypeError('Invalid URL'));

    const error = await assertSharedTextSafe(input).catch((e) => e);

    expect(error).toBeInstanceOf(SharedContentBlockedError);
    expect(isEscalatedServerFault(error)).toBe(false);
    expect((error as SharedContentBlockedError).category).toBe('link');
    expect((error as SharedContentBlockedError).message).toBe(
      'Content could not be reviewed right now. Please try again.'
    );
  });

  /**
   * A charged BAD_REQUEST is a client fault to the error classifier, so nothing downstream logs
   * it. Without this log a scan that throws on every write — e.g. a malformed cached list entry —
   * is charged to every caller and invisible to us. Logged once, at error severity, with the
   * error's message and never the user's text; still unescalated.
   */
  it('logs a non-block guard throw once at error severity, without the user text', async () => {
    throwOnBlockedUserContent.mockRejectedValue(new TypeError('Cannot read properties of null'));

    const error = await assertSharedTextSafe(input).catch((e) => e);

    expect(isEscalatedServerFault(error)).toBe(false);
    const errorLogs = loggingMock.logToAxiom.mock.calls.filter(
      ([entry]) => (entry as { type?: string })?.type === 'error'
    );
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0][0]).toEqual({
      name: 'app-shared-content-scan-failed',
      type: 'error',
      message: 'Shared-text blocklist scan threw; write refused and charged',
      details: {
        surface: 'appSharedStorage',
        errorName: 'TypeError',
        errorMessage: 'Cannot read properties of null',
      },
    });
  });

  it('logs nothing for a real block or a clean pass', async () => {
    await assertSharedTextSafe(input);
    blockWith('link');
    await assertSharedTextSafe(input).catch(() => undefined);

    expect(loggingMock.logToAxiom).not.toHaveBeenCalled();
  });

  it.each(['link', 'pattern'] as const)('a real %s block is NOT escalated', async (kind) => {
    blockWith(kind);

    const error = await assertSharedTextSafe(input).catch((e) => e);

    expect(error).toBeInstanceOf(SharedContentBlockedError);
    expect(isEscalatedServerFault(error)).toBe(false);
  });
});
