import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as OrchestratorService from '~/server/services/orchestrator/orchestrator.service';

vi.mock('~/server/services/orchestrator/orchestrator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorService>()),
  createXGuardModerationRequest: vi.fn(),
}));

const { submitTextModeration } = await import('~/server/services/text-moderation.service');
const { createXGuardModerationRequest } = await import(
  '~/server/services/orchestrator/orchestrator.service'
);

const OVERRIDES = [
  { label: 'explicit', action: 'Scan', threshold: 0.9, policy: 'candidate prose' },
];

describe('submitTextModeration label overrides', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards them to the orchestrator request', async () => {
    await submitTextModeration({
      entityType: 'Model',
      entityId: 7,
      content: 'a listing',
      labels: ['explicit'],
      labelOverrides: OVERRIDES,
    });

    expect(createXGuardModerationRequest).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'text', labelOverrides: OVERRIDES })
    );
  });

  // Accepting the parameter is not the same as passing it on. Dropping it from the call
  // body still typechecks and still satisfies every other assertion here, while scanning
  // every entity under the registry default.
  it('passes undefined rather than a stale value when none are given', async () => {
    await submitTextModeration({ entityType: 'Model', entityId: 7, content: 'a listing' });

    expect(createXGuardModerationRequest).toHaveBeenCalledWith(
      expect.objectContaining({ labelOverrides: undefined })
    );
  });
});
