import { describe, expect, it } from 'vitest';
import { runOracle, type AnyRecord } from './differential';
import { generationHub } from '../hub.graph';
import { reconcileSelectors } from '../reconcile';
import type { GenerationCtx } from '~/shared/data-graph/generation/context';

/**
 * Raw-AIR (training epoch blob) resources must survive the parse boundary WITH
 * their `air` + `workflowId` — both parse engines' resource output schemas
 * strip unknown keys, and this is the exact serialization that becomes the
 * whatIf/generate wire payload (WhatIfProvider / FormFooter both send parse
 * output). A schema that drops the fields ships a resource the server cannot
 * claim: `collectRawAirResources` never sees it, and `StrictAirMap.getOrThrow`
 * 400s on the synthetic negative id — every quote fails. Found by browser E2E
 * on the hub lane, whose schema had not mirrored the data-graph one.
 */

const AIR = 'urn:air:sdxl:lora:orchestrator:blob@blobkey123';
const WORKFLOW_ID = '5-1700000000000';

const EXT: GenerationCtx = {
  limits: { maxQuantity: 4, maxResources: 9, vidQuantity: 4 },
  user: { isMember: true, tier: 'gold' },
  flags: {},
  gateRules: [],
};

const INPUT: AnyRecord = {
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

function firstResource(data: AnyRecord) {
  return (data.resources as AnyRecord[] | undefined)?.[0];
}

describe('raw-AIR resource fields survive the parse boundary', () => {
  it('v1 data-graph keeps air + workflowId on the parsed resource', () => {
    const result = runOracle(INPUT, EXT);

    expect(result.success).toBe(true);
    const resource = firstResource(result.data);
    expect(resource?.air).toBe(AIR);
    expect(resource?.workflowId).toBe(WORKFLOW_ID);
  });

  it('form-graph hub keeps air + workflowId on the parsed resource', () => {
    const result = generationHub.parse(reconcileSelectors(INPUT).raw, EXT as never);

    expect(result.success).toBe(true);
    const resource = firstResource((result as { data: AnyRecord }).data);
    expect(resource?.air).toBe(AIR);
    expect(resource?.workflowId).toBe(WORKFLOW_ID);
  });
});
