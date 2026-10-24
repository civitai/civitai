import { describe, expect, it } from 'vitest';
import { BM, ECO, baseModelById, isModelSupported } from '@civitai/shared/basemodel.constants';
import { ModelType } from '~/shared/utils/prisma/enums';
import { trainingDetailsObj } from '~/server/schema/model-version.schema';
import { getBaseModelWarning } from '~/shared/constants/base-model-warnings.constants';
import { getDefaultEngine, isAiToolkitMandatory, trainingModelInfo } from '~/utils/training';

const info = trainingModelInfo.ideogram4;

describe('Ideogram 4 training wiring', () => {
  it('names a registered base model in the Ideogram ecosystem', () => {
    // `baseModel` is typed as the wide `BaseModel` string union, so a drifted name
    // compiles. It is stamped into the AIR of the finished LoRA, and a wrong one
    // fails the post-train scan rather than anything the trainer surfaces.
    const record = baseModelById.get(BM.Ideogram);
    expect(record?.name).toBe(info.baseModel);
    expect(record?.ecosystemId).toBe(ECO.Ideogram);
  });

  it('accepts a submitted run through the schema that gates persistence', () => {
    const parsed = trainingDetailsObj.safeParse({
      baseModel: 'ideogram4',
      baseModelType: 'ideogram4',
      type: 'Character',
      mediaType: 'image',
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('is AI-Toolkit-only, on the ecosystem the orchestrator expects', () => {
    expect(info.aiToolkit?.ecosystem).toBe('ideogram4');
    expect(info.aiToolkit?.modelVariant).toBeUndefined();
    expect(isAiToolkitMandatory('ideogram4')).toBe(true);
    expect(getDefaultEngine('ideogram4')).toBe('ai-toolkit');
  });

  it('publishes the trained LoRA on the Ideogram base model', () => {
    expect(isModelSupported(BM.Ideogram, 'training', ModelType.LORA)).toBe(true);
  });

  it('reaches the SFW/no-refund call-out from the trainer', () => {
    // The trainer resolves the warning through `trainingModelInfo[base].baseModel`.
    // If that name stops matching a key in baseModelWarnings the call-out silently
    // disappears and the submit gate stops firing — no type error either side.
    const warning = getBaseModelWarning(info.baseModel);
    expect(warning?.acknowledgement).toBeTruthy();
    expect(warning?.points.length).toBeGreaterThan(0);
  });
});
