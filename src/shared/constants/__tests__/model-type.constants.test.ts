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

  it('offers no retired type when nothing is selected yet', () => {
    const values = getModelTypeSelectData(null).map(({ value }) => value);

    for (const retired of retiredModelTypes) {
      expect(values, `${retired} is still offered to new models`).not.toContain(retired);
    }
    expect(values).toStrictEqual(selectableModelTypes);
  });

  it('emits flat items carrying a group, the shape SelectWrapper expects', () => {
    // Pre-grouped `{ group, items }` objects survive typecheck and render options with no value.
    for (const item of getModelTypeSelectData(ModelType.Hypernetwork)) {
      expect(Object.keys(item).sort()).toStrictEqual(['group', 'label', 'value']);
      expect(typeof item.value).toBe('string');
      expect(item.label.length).toBeGreaterThan(0);
    }
  });

  it('labels Checkpoint as Fine-tune', () => {
    expect(getDisplayName(ModelType.Checkpoint)).toBe('Fine-tune');
  });
});
