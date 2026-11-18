import { afterEach, describe, expect, test, vi } from 'vitest';
import { Accordion } from '@mantine/core';
import type * as FeatureFlagsModule from '~/providers/FeatureFlagsProvider';
import type { LinkedComponent } from '~/server/schema/model-file.schema';

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsModule>()),
  useFeatureFlags: () => ({ isGreen: false }),
}));

import { RequiredComponentsSection } from '~/components/Model/ModelVersions/RequiredComponentsSection';
import { renderWithProviders } from '../../../../test/component-setup';
import { cleanup } from 'vitest-browser-react';

afterEach(() => cleanup());

const linked: LinkedComponent = {
  componentType: 'VAE',
  modelId: 2,
  modelName: 'Linked model',
  versionId: 3,
  versionName: 'v1',
  fileId: 4,
  fileName: 'linked.safetensors',
};

const purchaseLabel = () =>
  Array.from(document.body.querySelectorAll('button'))
    .map((b) => b.textContent ?? '')
    .find((t) => t.includes('Purchase')) ?? null;

describe('Required components purchase button', () => {
  test.each([
    [3500, 'Purchase (3.5k Yellow Buzz)'],
    [4000, 'Purchase (4k Yellow Buzz)'],
  ])('a %i Buzz price reads %s', async (price, text) => {
    renderWithProviders(
      <Accordion defaultValue="required-components">
        <RequiredComponentsSection
          groupedFiles={{ requiredComponents: {} } as never}
          versionId={1}
          canDownload={false}
          downloadPrice={price}
          linkedComponents={[linked]}
        />
      </Accordion>
    );
    await vi.waitFor(() => expect(purchaseLabel()).toBe(text));
  });
});
