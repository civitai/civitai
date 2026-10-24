import { describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/component-setup';
import type * as ResourceDataProviderModule from '~/components/generation_v2/inputs/ResourceDataProvider';
import type { VersionGroup } from '~/shared/form-graph/generation/checkpoint';

/**
 * Swapping the checkpoint to one outside the ecosystem's version group (a community checkpoint,
 * a Flux tool model) used to remove the version selector, leaving no way back to an official
 * version short of the swap modal. The selector now stays, with nothing selected.
 */

vi.mock('~/components/generation_v2/inputs/ResourceDataProvider', async (orig) => ({
  ...(await orig<typeof ResourceDataProviderModule>()),
  useResourceDataContext: () => ({
    registerResourceId: () => undefined,
    unregisterResourceId: () => undefined,
    getResourceData: () => undefined,
    resources: [],
    isLoading: false,
    isResourceLoading: () => false,
  }),
}));

// eslint-disable-next-line import/first
import { VersionGroupSelector } from '~/components/form-graph/generation/form-helpers';

const OFF_LIST = 999;

const flat: VersionGroup = {
  options: [
    { label: 'Draft', value: 1 },
    { label: 'Standard', value: 2 },
    { label: 'Krea', value: 3 },
  ],
};

const nested: VersionGroup = {
  label: 'Precision',
  options: [
    {
      label: 'FP8',
      value: 11,
      children: {
        label: 'Variant',
        options: [
          { label: 'Fast', value: 10 },
          { label: 'Dev', value: 11 },
        ],
      },
    },
    {
      label: 'FP16',
      value: 21,
      children: {
        label: 'Variant',
        options: [
          { label: 'Fast', value: 20 },
          { label: 'Dev', value: 21 },
        ],
      },
    },
  ],
};

const buttonLabels = () =>
  Array.from(document.querySelectorAll('button')).map((b) => b.textContent?.trim());

const buttonNamed = (label: string) => {
  const el = Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label
  );
  if (!el) throw new Error(`button "${label}" not found`);
  return el;
};

// ButtonGroupInput marks the active option with a ring in the Mantine filled color.
const isActive = (label: string) =>
  buttonNamed(label).className.includes('mantine-color-blue-filled');

describe('VersionGroupSelector', () => {
  test('a model outside the group still lists every version, none selected', async () => {
    renderWithProviders(
      <VersionGroupSelector versions={flat} modelId={OFF_LIST} onChange={() => undefined} />
    );
    await vi.waitFor(() => expect(buttonLabels()).toEqual(['Draft', 'Standard', 'Krea']));
    expect(['Draft', 'Standard', 'Krea'].some(isActive)).toBe(false);
  });

  test('tapping a version from an outside model reports that version', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <VersionGroupSelector versions={flat} modelId={OFF_LIST} onChange={onChange} />
    );
    await vi.waitFor(() => buttonNamed('Standard'));
    buttonNamed('Standard').click();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ id: 2 });
  });

  test('a nested group with an outside model shows its parent dropdown labelled by the group', async () => {
    renderWithProviders(
      <VersionGroupSelector versions={nested} modelId={OFF_LIST} onChange={() => undefined} />
    );
    await vi.waitFor(() => expect(buttonLabels()).toEqual(['Precision']));
  });

  test('a model in the group shows only its own version as selected', async () => {
    renderWithProviders(
      <VersionGroupSelector versions={flat} modelId={2} onChange={() => undefined} />
    );
    await vi.waitFor(() => buttonNamed('Standard'));
    expect(isActive('Standard')).toBe(true);
    expect(isActive('Draft')).toBe(false);
    expect(isActive('Krea')).toBe(false);
  });

  test('a nested model in the group shows its parent level and selected variant', async () => {
    renderWithProviders(
      <VersionGroupSelector versions={nested} modelId={20} onChange={() => undefined} />
    );
    await vi.waitFor(() => expect(buttonLabels()).toEqual(['FP16', 'Fast', 'Dev']));
    expect(isActive('Fast')).toBe(true);
    expect(isActive('Dev')).toBe(false);
  });

  test('a single-version group renders nothing', async () => {
    const view = await renderWithProviders(
      <VersionGroupSelector versions={flat} modelId={2} onChange={() => undefined} />
    );
    await vi.waitFor(() => expect(buttonLabels()).toEqual(['Draft', 'Standard', 'Krea']));
    await view.rerender(
      <VersionGroupSelector
        versions={{ options: [{ label: 'v1', value: 1 }] }}
        modelId={OFF_LIST}
        onChange={() => undefined}
      />
    );
    await vi.waitFor(() => expect(buttonLabels()).toEqual([]));
  });

  test('no model selected renders nothing', async () => {
    const view = await renderWithProviders(
      <VersionGroupSelector versions={flat} modelId={2} onChange={() => undefined} />
    );
    await vi.waitFor(() => buttonNamed('Standard'));
    await view.rerender(
      <VersionGroupSelector versions={flat} modelId={undefined} onChange={() => undefined} />
    );
    await vi.waitFor(() => expect(buttonLabels()).toEqual([]));
  });
});
