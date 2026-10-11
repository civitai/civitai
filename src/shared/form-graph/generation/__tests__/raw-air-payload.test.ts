import { describe, expect, it } from 'vitest';
import { generationHub } from '../hub.graph';
import { reconcileSelectors } from '../reconcile';
import type { GenerationCtx } from '~/shared/generation/context';

/**
 * Raw-AIR (training epoch blob) resources must survive the parse boundary WITH their `air` +
 * `workflowId`. The resource output schema strips unknown keys, and this is the exact
 * serialization that becomes the whatIf/generate wire payload (WhatIfProvider and FormFooter
 * both send parse output). A schema that drops the fields ships a resource the server cannot
 * claim: `collectRawAirResources` never sees it and `StrictAirMap.getOrThrow` 400s on the
 * synthetic negative id, so every quote fails. Found by browser E2E, not by a unit test.
 */

const AIR = 'urn:air:sdxl:lora:orchestrator:blob@blobkey123';
const WORKFLOW_ID = '5-1700000000000';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

const INPUT = {
  output: 'image',
  workflow: 'txt2img',
  ecosystem: 'SDXL',
  prompt: 'a cat',
  resources: [
    {
      id: -42,
      baseModel: 'SDXL 1.0',
      model: { type: 'LORA' },
      strength: 1,
      air: AIR,
      workflowId: WORKFLOW_ID,
      name: 'my epoch',
    },
  ],
};

describe('raw-AIR resource fields survive the parse boundary', () => {
  it('keeps air + workflowId on the parsed resource', () => {
    const result = generationHub.parse(reconcileSelectors(INPUT).raw, EXT);
    expect(result.success).toBe(true);
    const resource = (result as { data: { resources?: Array<Record<string, unknown>> } }).data
      .resources?.[0];
    expect(resource?.air).toBe(AIR);
    expect(resource?.workflowId).toBe(WORKFLOW_ID);
  });
});
