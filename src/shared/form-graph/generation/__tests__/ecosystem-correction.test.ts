import { describe, expect, it } from 'vitest';
import { resolveCompatibleEcosystem } from '../ecosystem-gates';
import { generationHub } from '../hub.graph';

const EXT = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
  workflow: 'txt2img',
} as never;

describe('an ecosystem the workflow does not support', () => {
  const parsed = () =>
    generationHub.parse({ workflow: 'txt2img', ecosystem: 'Ace', prompt: 'a cat' }, EXT);

  it('is corrected rather than refused', () => {
    const result = parsed();
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((result.data as Record<string, unknown>).ecosystem).not.toBe('Ace');
  });

  it('says why, so the UI and the metrics tap can read it', () => {
    const result = parsed();
    expect(result.notes).toContainEqual(
      expect.objectContaining({ key: 'ecosystem', kind: 'ecosystem_workflow_unavailable' })
    );
  });

  // The hazard in correcting a DISCRIMINATOR: if the branch resolved before the
  // correction landed, the payload would carry audio fields under an image ecosystem.
  it('takes the family branch of the corrected value, not the submitted one', () => {
    const result = parsed();
    if (!result.success) throw new Error('parse failed');
    expect(Object.keys(result.data as Record<string, unknown>)).toEqual(
      expect.arrayContaining(['clipSkip', 'controlNets', 'vae'])
    );
  });
});

describe('the redirect target', () => {
  // The default comes from the usable set; `getDefaultEcosystemForWorkflow` is
  // `ecosystemIds[0]` and cannot see the gate, so without this the redirect can land
  // on a disabled ecosystem the output schema then refuses.
  it('skips a gated ecosystem instead of landing on it', () => {
    const ungated = resolveCompatibleEcosystem('txt2img', 'Ace');
    const gated = resolveCompatibleEcosystem(
      'txt2img',
      'Ace',
      ['SDXL', 'Illustrious'].filter((k) => k !== ungated)
    );
    expect(gated).not.toBe(ungated);
    expect(['SDXL', 'Illustrious']).toContain(gated);
  });

  it('leaves a value the workflow already supports alone', () => {
    expect(resolveCompatibleEcosystem('txt2img', 'SDXL', ['SDXL', 'Illustrious'])).toBe('SDXL');
  });
});
