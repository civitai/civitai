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
    const { applyTextScanVerdict } = await import('~/server/services/text-scan/verdict-applier');
    await applyTextScanVerdict('Post', args);
    expect(loggingMock.logToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'verdict applier not registered', entityType: 'Post' })
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
