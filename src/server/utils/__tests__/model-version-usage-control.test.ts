import { describe, expect, it } from 'vitest';
import { resolveGenerationOnlyGate } from '~/server/utils/model-version-usage-control';
import { ModelUsageControl } from '~/shared/utils/prisma/enums';

const base = {
  requested: ModelUsageControl.Generation,
  hasFeature: true,
  isModerator: false,
  permissions: undefined as string[] | undefined,
};

describe('resolveGenerationOnlyGate', () => {
  it('coerces to Download when the feature is absent', () => {
    const result = resolveGenerationOnlyGate({ ...base, hasFeature: false });
    expect(result).toEqual({ usageControl: ModelUsageControl.Download, outcome: 'denied' });
  });

  it('coerces an absent usage control to Download when the feature is absent', () => {
    const result = resolveGenerationOnlyGate({
      ...base,
      requested: undefined,
      hasFeature: false,
    });
    expect(result.usageControl).toBe(ModelUsageControl.Download);
  });

  it('keeps the requested control and reports the moderator branch', () => {
    const result = resolveGenerationOnlyGate({ ...base, isModerator: true });
    expect(result).toEqual({ usageControl: ModelUsageControl.Generation, outcome: 'moderator' });
  });

  it('reports the granted branch for an explicit permission grant', () => {
    const result = resolveGenerationOnlyGate({ ...base, permissions: ['generationOnlyModels'] });
    expect(result).toEqual({ usageControl: ModelUsageControl.Generation, outcome: 'granted' });
  });

  it('reports the membership branch when neither moderator nor granted', () => {
    const result = resolveGenerationOnlyGate(base);
    expect(result).toEqual({ usageControl: ModelUsageControl.Generation, outcome: 'tier' });
  });

  it('prefers the moderator branch over an unrelated permission list', () => {
    const result = resolveGenerationOnlyGate({
      ...base,
      isModerator: true,
      permissions: ['someOtherFeature'],
    });
    expect(result.outcome).toBe('moderator');
  });

  it('does not treat an unrelated permission as a grant', () => {
    const result = resolveGenerationOnlyGate({ ...base, permissions: ['someOtherFeature'] });
    expect(result.outcome).toBe('tier');
  });
});
