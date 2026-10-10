import { describe, expect, it } from 'vitest';
import type { GenerationCtx } from '~/shared/generation/context';
import { probeFieldMeta } from '../field-probe';

const CTX: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 10, vidQuantity: 1 },
  user: { isMember: false, tier: 'free' },
  flags: {},
  selfHostedDisabledEcosystems: [],
  selfHostedMode: 'enabled',
  gateRules: [],
};

/**
 * The guard decides what "cannot determine" means, and App Blocks fails CLOSED on it — so
 * both directions need pinning. Without these, the two obvious wrong guards (ecosystem
 * equality, correction notes) both leave the suite green: one rejects a large set of correct answers,
 * the other never fires.
 */
describe('probeFieldMeta guards on the workflow, not the ecosystem', () => {
  it('answers for a standalone workflow, whose ecosystem correctly resolves to undefined', () => {
    // An ecosystem-equality guard returns undefined here. There is no redirect — the concept
    // of an ecosystem does not apply to this workflow.
    // `img2img:upscale` resolves its ecosystem to undefined and still carries a distinctive
    // limit, so this asserts the answer rather than merely that something came back.
    expect(
      probeFieldMeta('images', { workflow: 'img2img:upscale', ecosystem: 'Flux1' }, CTX)
    ).toMatchObject({ min: 1, max: 10 });
  });

  it('answers when the hub keeps the stated ecosystem and corrects the model instead', () => {
    expect(
      probeFieldMeta('images', { workflow: 'img2vid', ecosystem: 'WanVideo14B_T2V' }, CTX)
    ).toMatchObject({ min: 1, max: 1 });
  });

  it('refuses a workflow the hub had to coerce — it would describe txt2img instead', () => {
    // `migrateWorkflowKey` turns an unknown key into `txt2img` on the input path, with no note.
    // 🔴 PROBED ON `cfgScale`, NOT `images`, ON PURPOSE. txt2img has no `images` field, so an
    // `images` probe here answers undefined whether the guard exists or not — the first version
    // of this test passed with the guard DELETED. cfgScale is a field txt2img does have, so the
    // coerced answer is observable: unguarded this returns txt2img's {min:1,max:10,...}.
    expect(
      probeFieldMeta('cfgScale', { workflow: 'not-a-real-workflow', ecosystem: 'SDXL' }, CTX)
    ).toBeUndefined();
    expect(
      probeFieldMeta('cfgScale', { workflow: 'txt2img', ecosystem: 'SDXL' }, CTX)
    ).toBeDefined();
  });

  it('returns undefined for a field the workflow does not have', () => {
    expect(
      probeFieldMeta('images', { workflow: 'txt2img', ecosystem: 'SDXL' }, CTX)
    ).toBeUndefined();
  });
});
