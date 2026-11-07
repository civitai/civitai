import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcMod from '~/utils/trpc';
import { renderWithProviders } from '../../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

const PARTNER =
  'A partner runs this model. Your prompt and files go to the partner to create your result.';
const TRAINS =
  "This partner may use your prompt and results to improve its models. Don't include anything private.";

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcMod>()),
  trpc: makeTrpcProxy({}),
}));

vi.mock('~/components/ImageGeneration/GenerationForm/ResourceSelectProvider', () => ({
  useResourceSelectContext: () => ({
    onSelect: vi.fn(),
    selectSource: 'generation',
    resources: [{ type: 'Checkpoint', baseModels: ['Illustrious'] }],
    filters: { types: [], baseModels: [], loadedOnly: false, turboOnly: false },
    multiSelect: false,
    isStaged: () => false,
    staged: [],
  }),
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => null }));

const { ResourceSelectCard } = await import('./ResourceSelectCard');

const version = (id: number, name: string, extra: object) => ({
  id,
  name,
  baseModel: 'Illustrious',
  canGenerate: true,
  canGenerateNext: true,
  generatorLoaded: true,
  metrics: { downloadCount: 0, generationCount: 0, thumbsUpCount: 0, thumbsDownCount: 0 },
  ...extra,
});

const hit = {
  id: 9001,
  name: 'Test Model',
  type: 'Checkpoint',
  images: [
    { id: 1, url: 'x', width: 512, height: 512, type: 'image', nsfwLevel: 1, modelVersionId: 9101 },
  ],
  user: { id: 1, username: 'someone' },
  version: version(9101, 'v2', { partnerService: true, partnerTrains: true }),
  versions: [
    version(9101, 'v2', { partnerService: true, partnerTrains: true }),
    version(9102, 'v1', { partnerService: false, partnerTrains: false }),
  ],
};

describe('ResourceSelectCard partner icons', () => {
  test('the shown version carries both icons from its search entry', async () => {
    renderWithProviders(
      <ResourceSelectCard data={hit as never} selectSource="generation" compact />
    );
    await expect
      .element(page.getByRole('button', { name: PARTNER, exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: TRAINS, exact: true }))
      .toBeInTheDocument();
  });

  test('a version no partner runs shows neither icon', async () => {
    renderWithProviders(
      <ResourceSelectCard
        data={{ ...hit, version: hit.versions[1], versions: [hit.versions[1]] } as never}
        selectSource="generation"
        compact
      />
    );
    await expect.element(page.getByText('Test Model')).toBeInTheDocument();
    expect(document.querySelectorAll('[role="button"][aria-label^="A partner"]')).toHaveLength(0);
    expect(document.querySelectorAll('[role="button"][aria-label^="This partner"]')).toHaveLength(
      0
    );
  });
});
