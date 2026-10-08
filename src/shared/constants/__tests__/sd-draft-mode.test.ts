import { describe, expect, it } from 'vitest';
import { allInjectableResourceIds, getSdDraftMode } from '~/shared/constants/generation.constants';
import { parseAIRSafe } from '~/shared/utils/air';

describe('sd draft mode', () => {
  it.each(['SDXL', 'SD1'])(
    '%s: the injected AIR names the same version as loraVersionId',
    (eco) => {
      const mode = getSdDraftMode(eco);
      expect(parseAIRSafe(mode.air)?.version).toBe(mode.loraVersionId);
      expect(allInjectableResourceIds).toContain(mode.loraVersionId);
    }
  );

  it('the defaults sit inside their ranges', () => {
    for (const eco of ['SDXL', 'SD1']) {
      const { steps, cfgScale } = getSdDraftMode(eco);
      for (const r of [steps, cfgScale]) {
        expect(r.default).toBeGreaterThanOrEqual(r.min);
        expect(r.default).toBeLessThanOrEqual(r.max);
      }
    }
  });
});
