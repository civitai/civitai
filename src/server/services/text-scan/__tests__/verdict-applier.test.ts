import { describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';

const args = {
  entityId: 7,
  workflowId: 'wf-1',
  outcome: { triggeredLabels: [], nsfwLevel: null },
  subject: { fields: [], declared: {} },
  textHash: 'h',
} as never;

describe('applying a text-scan verdict', () => {
  it('logs an error and applies nothing before the registry has loaded', async () => {
    vi.resetModules();
    globalThis.__civitaiTextScanVerdictApplier = undefined;
    const { applyTextScanVerdict } = await import('~/server/services/text-scan/verdict-applier');
    await applyTextScanVerdict('Post', args);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'verdict applier not registered', entityType: 'Post' })
    );
  });

  // Without instrumentation (it failed, or never ran), the tRPC entry still registers it, so a
  // stale verdict cleared during a request (submit.ts clearStaleVerdict) is applied.
  it('is registered by loading the tRPC router, without instrumentation', async () => {
    vi.resetModules();
    globalThis.__civitaiTextScanVerdictApplier = undefined;
    await import('~/server/routers');
    expect(globalThis.__civitaiTextScanVerdictApplier).toBeDefined();

    const { getModerationAdapter } = await import('~/server/services/moderation-adapters');
    const { applyTextScanVerdict } = await import('~/server/services/text-scan/verdict-applier');
    const apply = vi
      .spyOn(getModerationAdapter('Post')!, 'applyTextScan')
      .mockResolvedValue(undefined as never);
    vi.mocked(loggingMock.logToAxiom).mockClear();

    await applyTextScanVerdict('Post', args);

    expect(apply).toHaveBeenCalledWith(args);
    expect(loggingMock.logToAxiom).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: 'verdict applier not registered' })
    );
  });

  // The server loads the registry at start (instrumentation.ts), so this is the production wiring.
  it("reaches the entity's own adapter once the registry has loaded", async () => {
    vi.resetModules();
    const { getModerationAdapter } = await import('~/server/services/moderation-adapters');
    const { applyTextScanVerdict } = await import('~/server/services/text-scan/verdict-applier');
    const adapter = getModerationAdapter('Article')!;
    const apply = vi.spyOn(adapter, 'applyTextScan').mockResolvedValue(undefined as never);

    await applyTextScanVerdict('Article', args);

    expect(apply).toHaveBeenCalledWith(args);
  });
});

// The build emits verdict-applier.ts more than once; a setter reaching one copy must reach them all.
it('is shared by every copy of the module, not only the one the registry set', async () => {
  vi.resetModules();
  const first = await import('~/server/services/text-scan/verdict-applier');
  const apply = vi.fn();
  first.setTextScanVerdictApplier(apply);
  vi.resetModules();
  const second = await import('~/server/services/text-scan/verdict-applier');
  expect(second).not.toBe(first);
  await second.applyTextScanVerdict('Article', args);
  expect(apply).toHaveBeenCalledWith('Article', args);
});
