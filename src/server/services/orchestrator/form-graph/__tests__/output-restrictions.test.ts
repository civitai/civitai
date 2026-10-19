import { describe, expect, it } from 'vitest';
import { workflowOutputRestrictions } from '../output-restrictions';

describe('workflowOutputRestrictions', () => {
  it('caps avatar workflows even when the caller allows mature content', () => {
    expect(
      workflowOutputRestrictions({
        workflow: 'img2img:avatar',
        isPrivateGeneration: false,
        allowMatureContent: true,
      })
    ).toEqual({ nsfwLevel: 'pg13', allowMatureContent: false });
  });

  it('caps private generation on any workflow', () => {
    expect(
      workflowOutputRestrictions({
        workflow: 'txt2img',
        isPrivateGeneration: true,
        allowMatureContent: true,
      })
    ).toEqual({ nsfwLevel: 'pg13', allowMatureContent: false });
  });

  it("leaves other workflows to the caller's choice", () => {
    expect(
      workflowOutputRestrictions({
        workflow: 'txt2img',
        isPrivateGeneration: false,
        allowMatureContent: true,
      })
    ).toEqual({ nsfwLevel: undefined, allowMatureContent: true });
  });
});
