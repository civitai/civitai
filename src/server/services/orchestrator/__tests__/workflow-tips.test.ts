import { describe, expect, it } from 'vitest';
import { buildWorkflowTips } from '~/server/services/orchestrator/workflow-tips';

describe('buildWorkflowTips', () => {
  it('passes the creator tip through when a resource is eligible', () => {
    expect(
      buildWorkflowTips({ civitaiTip: 0.05, creatorTip: 0.25, hasTipEligibleResource: true })
    ).toEqual({ civitai: 0.05, creators: 0.25 });
  });

  it('drops the creator tip when no resource is eligible, keeping the Civitai tip', () => {
    expect(
      buildWorkflowTips({ civitaiTip: 0.05, creatorTip: 0.25, hasTipEligibleResource: false })
    ).toEqual({ civitai: 0.05, creators: 0 });
  });

  it('sends no tips body when nothing is left to charge', () => {
    expect(
      buildWorkflowTips({ civitaiTip: 0, creatorTip: 0.25, hasTipEligibleResource: false })
    ).toBeUndefined();
    expect(buildWorkflowTips({ hasTipEligibleResource: true })).toBeUndefined();
  });
});

describe('buildWorkflowTips — rate bounds', () => {
  it('clamps rates into 0..1', () => {
    expect(
      buildWorkflowTips({ civitaiTip: 3, creatorTip: -0.5, hasTipEligibleResource: true })
    ).toEqual({ civitai: 1, creators: 0 });
  });

  it('treats a non-numeric rate as no tip', () => {
    expect(
      buildWorkflowTips({ civitaiTip: '0.5', creatorTip: 0, hasTipEligibleResource: true })
    ).toBeUndefined();
    expect(
      buildWorkflowTips({ civitaiTip: 0.05, creatorTip: NaN, hasTipEligibleResource: true })
    ).toEqual({ civitai: 0.05, creators: 0 });
  });
});
