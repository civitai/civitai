import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import { MediaType } from '~/shared/utils/prisma/enums';
import type * as TrpcModule from '~/utils/trpc';

type Version = { id: number; name: string; baseModel: string; modelId: number; modelName: string };

const mocks = vi.hoisted(() => ({
  versions: [] as Version[],
  openResourceSelectModal: vi.fn(),
}));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: {
    modelVersion: {
      getVersionsByIds: { useQuery: () => ({ data: mocks.versions, isLoading: false }) },
    },
  },
}));
vi.mock('~/components/Dialog/triggers/resource-select', () => ({
  openResourceSelectModal: mocks.openResourceSelectModal,
}));

const { ModelVersionMultiSelect } = await import('~/components/Challenge/ModelVersionMultiSelect');

const version = (id: number, baseModel: string): Version => ({
  id,
  name: `v${id}`,
  baseModel,
  modelId: id,
  modelName: `Model ${id}`,
});

const openPicker = async () => {
  await userEvent.click(page.getByRole('button', { name: 'Add Resource' }));
  return mocks.openResourceSelectModal.mock.calls[0][0];
};

beforeEach(() => {
  mocks.openResourceSelectModal.mockReset();
  mocks.versions = [];
});

describe('ModelVersionMultiSelect with a media type', () => {
  test('flags a picked model that makes the other media type', async () => {
    mocks.versions = [version(1, 'SDXL 1.0'), version(2, 'MiniMax H3')];
    renderWithProviders(<ModelVersionMultiSelect value={[1, 2]} mediaType={MediaType.image} />);

    await expect.element(page.getByText('Model 2')).toBeVisible();
    expect(document.body.textContent?.match(/Doesn't make images/g)).toHaveLength(1);
  });

  test('searches only base models that make it', async () => {
    renderWithProviders(<ModelVersionMultiSelect value={[]} mediaType={MediaType.video} />);

    const { options } = await openPicker();
    for (const { baseModels } of options.resources) {
      expect(baseModels).toContain('MiniMax H3');
      expect(baseModels).not.toContain('SDXL 1.0');
    }
  });

  test('refuses a pick that makes the other media type and keeps the rest', async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <ModelVersionMultiSelect value={[]} onChange={onChange} mediaType={MediaType.image} />
    );

    const { onSelectMultiple } = await openPicker();
    onSelectMultiple([
      { id: 5, baseModel: 'MiniMax H3', model: { name: 'Video LoRA' } },
      { id: 6, baseModel: 'SDXL 1.0', model: { name: 'Image LoRA' } },
    ]);

    expect(onChange).toHaveBeenCalledWith([6]);
  });
});

describe('ModelVersionMultiSelect without a media type', () => {
  test('leaves the search unfiltered, as challenges use it', async () => {
    renderWithProviders(<ModelVersionMultiSelect value={[]} />);

    const { options } = await openPicker();
    expect(options.resources.every((r: { baseModels?: string[] }) => !r.baseModels)).toBe(true);
  });
});
