import { describe, expect, it } from 'vitest';
import { getDefaultEngine } from '~/utils/training';

describe('getDefaultEngine with Kohya off', () => {
  it('defaults Flux to AI Toolkit when AI Toolkit is on for Flux', () => {
    expect(
      getDefaultEngine('flux', 'flux_dev', { kohyaTraining: false, aiToolkitFlux: true })
    ).toBe('ai-toolkit');
  });

  it('falls back to Rapid for Flux when AI Toolkit is off for Flux', () => {
    expect(
      getDefaultEngine('flux', 'flux_dev', { kohyaTraining: false, aiToolkitFlux: false })
    ).toBe('rapid');
  });

  it('never returns Kohya for SDXL', () => {
    expect(
      getDefaultEngine(
        'sdxl',
        'sdxl',
        { kohyaTraining: false, aiToolkitSdxl: true },
        {
          ignoreDefaultPreference: true,
        }
      )
    ).toBe('ai-toolkit');
  });
});
