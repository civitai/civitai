import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  currentlySelectedGroupLabel,
  getModelTypeSelectData,
  modelTypeGroups,
  retiredModelTypes,
  selectableModelTypes,
} from '~/shared/constants/model-type.constants';
import { ModelType } from '~/shared/utils/prisma/enums';
import { getDisplayName } from '~/utils/string-helpers';

describe('model type picker data', () => {
  it('covers every ModelType exactly once, as selectable or retired', () => {
    const all = [...selectableModelTypes, ...retiredModelTypes].sort();

    expect(all).toStrictEqual([...Object.values(ModelType)].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it('offers only the types the 2026-08-31 cleanup kept', () => {
    expect(selectableModelTypes).toStrictEqual([
      ModelType.Checkpoint,
      ModelType.LORA,
      ModelType.LoCon,
      ModelType.DoRA,
      ModelType.VAE,
      ModelType.TextEncoder,
      ModelType.UNet,
      ModelType.Upscaler,
      ModelType.Workflows,
      ModelType.Wildcards,
      ModelType.Controlnet,
      ModelType.Other,
    ]);
  });

  it('groups Controlnet with the workflow additives, not the adapters', () => {
    const groupOf = (type: ModelType) =>
      modelTypeGroups.find(({ types }) => types.includes(type))?.group;

    expect(groupOf(ModelType.Controlnet)).toBe('Workflow additives');
    expect(groupOf(ModelType.LORA)).toBe('Adapters');
  });

  it('keeps a retired type selectable while it is the current value', () => {
    // A model already set to a retired type must survive an edit of any other field. If the picker
    // drops the value, Mantine renders an empty Type field and the next save writes whatever the
    // user re-picks.
    for (const retired of retiredModelTypes) {
      const values = getModelTypeSelectData(retired).map(({ value }) => value);

      expect(values, `${retired} is missing from its own picker`).toContain(retired);
    }
  });

  it('shows the grandfathered value first, under its own group, exactly once', () => {
    const data = getModelTypeSelectData(ModelType.ComfyWorkflows);

    expect(data[0]).toStrictEqual({
      value: ModelType.ComfyWorkflows,
      label: getDisplayName(ModelType.ComfyWorkflows),
      group: currentlySelectedGroupLabel,
    });
    expect(data.filter(({ value }) => value === ModelType.ComfyWorkflows)).toHaveLength(1);
  });

  it('does not add a grandfather group for a type that is still offered', () => {
    const data = getModelTypeSelectData(ModelType.Checkpoint);

    expect(data.map(({ group }) => group)).not.toContain(currentlySelectedGroupLabel);
    expect(data.filter(({ value }) => value === ModelType.Checkpoint)).toHaveLength(1);
  });

  it('lists both partitions explicitly, so a new ModelType cannot become silently unpickable', () => {
    // retiredModelTypes is written out rather than derived as the complement of the selectable set.
    // Derived, a ModelType added later would land in it and this file would stay green.
    expect([...retiredModelTypes]).toStrictEqual([
      ModelType.TextualInversion,
      ModelType.Hypernetwork,
      ModelType.AestheticGradient,
      ModelType.MotionModule,
      ModelType.Poses,
      ModelType.Detection,
      ModelType.ComfyWorkflows,
      ModelType.CLIP,
      ModelType.CLIPVision,
      ModelType.LLM,
      ModelType.VisionLanguage,
    ]);
  });

  it('offers no retired type when nothing is selected yet', () => {
    const values = getModelTypeSelectData(null).map(({ value }) => value);

    for (const retired of retiredModelTypes) {
      expect(values, `${retired} is still offered to new models`).not.toContain(retired);
    }
    expect(values).toStrictEqual(selectableModelTypes);
  });

  it('emits flat items carrying a group, the shape SelectWrapper expects', () => {
    // SelectWrapper does the grouping itself; pre-grouped `{ group, items }` renders valueless
    // options.
    for (const item of getModelTypeSelectData(ModelType.Hypernetwork)) {
      expect(Object.keys(item).sort()).toStrictEqual(['group', 'label', 'value']);
      expect(typeof item.value).toBe('string');
      expect(item.label.length).toBeGreaterThan(0);
    }
  });

  it('reads the grandfathered type from the saved model, never from the form', () => {
    // This has to be asserted at the call site: both ways of getting it wrong type-check and pass
    // every test above. Passing the watched `type` drops the grandfathered option the moment the
    // user clicks another one, so the original becomes unrecoverable; and a template seeds `type`
    // with no `id`, so keying off anything but `model?.id` lets `/models/create?templateId=` mint a
    // new model on a retired type — the thing retiring it was meant to stop.
    const source = readFileSync(
      path.resolve(__dirname, '../../../components/Resource/Forms/ModelUpsertForm.tsx'),
      'utf8'
    );

    expect(source).toContain('const grandfatheredType = model?.id ? model.type : null;');
    expect(source).toContain('data={getModelTypeSelectData(grandfatheredType)}');
    expect(source).not.toContain('getModelTypeSelectData(type)');
  });

  it('labels Checkpoint as Fine-tune', () => {
    expect(getDisplayName(ModelType.Checkpoint)).toBe('Fine-tune');
  });
});
