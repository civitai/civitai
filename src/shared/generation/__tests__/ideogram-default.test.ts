import { describe, expect, it } from 'vitest';
import { ECO, ecosystemSettings } from '~/shared/constants/basemodel.constants';
import { ideogramVersionIds } from '~/shared/form-graph/generation/image/ideogram.graph';
import { getWorkflowCapability } from '~/shared/generation/workflow-capability';

// Ideogram 4.0 generation is switched off; a user opening Ideogram must not land on it and fail at submit.
const v40 = ideogramVersionIds['v4.0'];

describe('Ideogram generator default', () => {
  it.each(['txt2img', 'img2img:edit'])('%s neither defaults to nor offers 4.0', (workflow) => {
    const capability = getWorkflowCapability('Ideogram', workflow);
    expect(capability?.defaultModelId).toBe(ideogramVersionIds['v4.5']);
    expect(JSON.stringify(capability?.versions)).not.toContain(String(v40));
  });

  it('the locked ecosystem default is 4.5', () => {
    const settings = ecosystemSettings.find((s) => s.ecosystemId === ECO.Ideogram);
    expect(settings?.defaults?.model?.id).toBe(ideogramVersionIds['v4.5']);
  });
});
