import { describe, expect, it } from 'vitest';
import { capsGenerationOutput, workflowOutputRestrictions } from '../output-restrictions';

describe('workflowOutputRestrictions', () => {
  it('caps avatar workflows even when the caller allows mature content', () => {
    expect(
      workflowOutputRestrictions({
        workflow: 'img2img:avatar',
        isPrivateGeneration: false,
        capOutput: false,
        allowMatureContent: true,
      })
    ).toEqual({ nsfwLevel: 'pg13', allowMatureContent: false });
  });

  it('caps private generation on any workflow', () => {
    expect(
      workflowOutputRestrictions({
        workflow: 'txt2img',
        isPrivateGeneration: true,
        capOutput: false,
        allowMatureContent: true,
      })
    ).toEqual({ nsfwLevel: 'pg13', allowMatureContent: false });
  });

  it("leaves other workflows to the caller's choice", () => {
    expect(
      workflowOutputRestrictions({
        workflow: 'txt2img',
        isPrivateGeneration: false,
        capOutput: false,
        allowMatureContent: true,
      })
    ).toEqual({ nsfwLevel: undefined, allowMatureContent: true });
  });

  it('caps a submit whose base-model licence caps output', () => {
    expect(
      workflowOutputRestrictions({
        workflow: 'txt2img',
        isPrivateGeneration: false,
        capOutput: true,
        allowMatureContent: true,
      })
    ).toEqual({ nsfwLevel: 'pg13', allowMatureContent: false });
  });
});

describe('capsGenerationOutput', () => {
  const caps = (input: Partial<Parameters<typeof capsGenerationOutput>[0]>) =>
    capsGenerationOutput({ baseModels: [], rawAirs: [], ...input });

  it('caps a Fibo 2.0 checkpoint', () => {
    expect(caps({ baseModels: ['Fibo 2.0'] })).toBe(true);
  });

  it('caps a Fibo 2.0 LoRA inside an otherwise unflagged request', () => {
    expect(caps({ baseModels: ['SDXL 1.0', 'Fibo 2.0'], requestEcosystem: 'SDXL' })).toBe(true);
  });

  it('caps a raw-AIR Fibo 2.0 epoch, which carries no base model', () => {
    expect(caps({ rawAirs: ['urn:air:fibo2:lora:orchestrator:blob@abc'] })).toBe(true);
  });

  it('caps a Fibo 2.0 request with no resources, as an edit sends', () => {
    expect(caps({ requestEcosystem: 'Fibo2' })).toBe(true);
  });

  it('caps a raw AIR it cannot resolve to an ecosystem', () => {
    expect(caps({ rawAirs: ['urn:air:nosuchecosystem:lora:orchestrator:blob@abc'] })).toBe(true);
    expect(caps({ rawAirs: ['not-an-air'] })).toBe(true);
  });

  it('CONTROL: leaves an all-unflagged request uncapped', () => {
    expect(
      caps({
        baseModels: ['SDXL 1.0', 'Pony'],
        rawAirs: ['urn:air:sdxl:lora:orchestrator:blob@abc'],
        requestEcosystem: 'SDXL',
      })
    ).toBe(false);
  });

  it('CONTROL: leaves Ideogram uncapped, whose licence disables mature listings but not output', () => {
    expect(caps({ baseModels: ['Ideogram 4.0'], requestEcosystem: 'Ideogram' })).toBe(false);
  });
});
