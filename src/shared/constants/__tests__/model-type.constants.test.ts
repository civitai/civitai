import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  currentlySelectedGroupLabel,
  getModelTypeSelectData,
  modelTypeGroups,
  resolveModelTypeDefaults,
  retiredModelTypes,
  selectableModelTypes,
  ungroupedModelTypes,
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
    const data = getModelTypeSelectData(ModelType.Hypernetwork);

    for (const item of data) {
      expect(Object.keys(item).sort()).toStrictEqual(
        item.group ? ['group', 'label', 'value'] : ['label', 'value']
      );
      expect(typeof item.value).toBe('string');
      expect(item.label.length).toBeGreaterThan(0);
    }

    // Only the trailing ungrouped types have no heading; a group of one would repeat its own name.
    expect(data.filter(({ group }) => !group).map(({ value }) => value)).toStrictEqual([
      ...ungroupedModelTypes,
    ]);
  });

  it('grandfathers a saved model, and offers a template only what is still offered', () => {
    // A saved model keeps a retired type and the picker re-offers it.
    const saved = resolveModelTypeDefaults({ id: 7, type: ModelType.TextualInversion });
    expect(saved).toStrictEqual({
      grandfatheredType: ModelType.TextualInversion,
      initialType: ModelType.TextualInversion,
    });
    expect(getModelTypeSelectData(saved.grandfatheredType).map(({ value }) => value)).toContain(
      ModelType.TextualInversion
    );

    // A template seeds `type` with no `id`, so it is a NEW model. Dropping the option alone is not
    // enough: the form would still hold the retired value behind a blank required field, and the
    // submit would create a model on it.
    // Falling back to Checkpoint would file it as a fine-tune; Other claims nothing.
    const fromTemplate = resolveModelTypeDefaults({ type: ModelType.TextualInversion });
    expect(fromTemplate).toStrictEqual({
      grandfatheredType: null,
      initialType: ModelType.Other,
    });

    // A template on a type that is still offered is untouched.
    expect(resolveModelTypeDefaults({ type: ModelType.LORA })).toStrictEqual({
      grandfatheredType: null,
      initialType: ModelType.LORA,
    });
    expect(resolveModelTypeDefaults(undefined)).toStrictEqual({
      grandfatheredType: null,
      initialType: ModelType.Checkpoint,
    });
  });

  it('never leaves the form holding a type the picker will not show', () => {
    // The pairing is the invariant, not either half: whatever the form starts on must be in the
    // picker's data, or Mantine renders a blank input over a value the submit still sends.
    const seeds = [
      { id: 7, type: ModelType.ComfyWorkflows },
      { id: 7, type: ModelType.Checkpoint },
      { type: ModelType.Hypernetwork },
      { type: ModelType.LORA },
      undefined,
    ];

    for (const seed of seeds) {
      const { grandfatheredType, initialType } = resolveModelTypeDefaults(seed);
      const offered = getModelTypeSelectData(grandfatheredType).map(({ value }) => value);

      expect(
        offered,
        `${JSON.stringify(seed)} starts on ${initialType}, absent from its picker`
      ).toContain(initialType);
    }
  });

  it('wires the picker to the resolver rather than to the form value', () => {
    // Both halves have to come from the same call: passing the watched form value type-checks and
    // passes every assertion above, while dropping the grandfathered option on the first click.
    const source = readFileSync(
      path.resolve(__dirname, '../../../components/Resource/Forms/ModelUpsertForm.tsx'),
      'utf8'
    );

    expect(source).toMatch(/resolveModelTypeDefaults\(initialModel\)/);
    expect(source).toMatch(/getModelTypeSelectData\(grandfatheredType\)/);
    expect(source).toMatch(/type: initialType,/);
    expect(source).not.toContain('getModelTypeSelectData(type)');
    expect(source).not.toContain('resolveModelTypeDefaults(model)');
  });

  it('labels Checkpoint as Fine-tune', () => {
    expect(getDisplayName(ModelType.Checkpoint)).toBe('Fine-tune');
  });
});
