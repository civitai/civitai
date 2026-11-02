import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import { renderWithProviders } from '../../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../../test/trpcProxyStub';

const mocks = vi.hoisted(() => ({ files: [] as Record<string, unknown>[] }));

vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ creatorServices: true }),
}));
vi.mock('~/utils/notifications', () => ({ showErrorNotification: vi.fn() }));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpc: makeTrpcProxy({
    'creatorServiceDealFile.list': {
      useQuery: () => ({ data: mocks.files, isLoading: false }),
    },
  }),
}));

import { DealFilesPanel } from '~/components/CreatorShop/Services/deals/DealFilesPanel';
import type { ServiceDealView } from '~/components/CreatorShop/Services/deals/deal.util';

const deal = (previewKind = 'Image') =>
  ({
    id: 7,
    status: 'Accepted',
    viewerRole: 'seller',
    revisionsUsed: 0,
    previewKind,
  } as unknown as ServiceDealView);

let nextId = 1;
const file = (kind: 'Preview' | 'Final', over: Record<string, unknown> = {}) => ({
  id: nextId++,
  round: 0,
  kind,
  status: 'Ready',
  scanStatus: 'Passed',
  canDownload: true,
  fileName: `${kind}.png`,
  ...over,
});

const deliver = () => page.getByRole('button', { name: 'Deliver' });

beforeEach(() => {
  mocks.files = [];
});

// "Both present" is the control: the same render with the button enabled, so the disabled
// cases below cannot be a button that is always disabled.
describe('Deliver on the seller panel', () => {
  test('is disabled with a hint when the round has no files', async () => {
    renderWithProviders(<DealFilesPanel deal={deal()} />);
    await expect.element(deliver()).toBeDisabled();
    await expect
      .element(page.getByText('Add a preview and your final files to deliver.'))
      .toBeInTheDocument();
  });

  test('is disabled with only a passed preview', async () => {
    mocks.files = [file('Preview')];
    renderWithProviders(<DealFilesPanel deal={deal()} />);
    await expect.element(deliver()).toBeDisabled();
    await expect.element(page.getByText('Add your final files to deliver.')).toBeInTheDocument();
  });

  test('is disabled with only a passed final when a preview is required', async () => {
    mocks.files = [file('Final')];
    renderWithProviders(<DealFilesPanel deal={deal()} />);
    await expect.element(deliver()).toBeDisabled();
    await expect.element(page.getByText('Add a preview to deliver.')).toBeInTheDocument();
  });

  test('is disabled while a final is still being scanned', async () => {
    mocks.files = [file('Preview'), file('Final', { scanStatus: 'Pending' })];
    renderWithProviders(<DealFilesPanel deal={deal()} />);
    await expect.element(deliver()).toBeDisabled();
  });

  test('is enabled with a passed preview and a passed final', async () => {
    mocks.files = [file('Preview'), file('Final')];
    renderWithProviders(<DealFilesPanel deal={deal()} />);
    await expect.element(deliver()).toBeEnabled();
    expect(page.getByText(/to deliver\./).elements()).toHaveLength(0);
  });

  test('is disabled when a failed final sits beside a passed one', async () => {
    mocks.files = [file('Preview'), file('Final'), file('Final', { status: 'Failed' })];
    renderWithProviders(<DealFilesPanel deal={deal()} />);
    await expect.element(deliver()).toBeDisabled();
    await expect
      .element(page.getByText('Remove or replace the file that failed.'))
      .toBeInTheDocument();
  });

  test('is disabled when a final failed its scan beside a passed one', async () => {
    mocks.files = [file('Preview'), file('Final'), file('Final', { scanStatus: 'Failed' })];
    renderWithProviders(<DealFilesPanel deal={deal()} />);
    await expect.element(deliver()).toBeDisabled();
  });

  test('ignores files from other rounds', async () => {
    mocks.files = [file('Preview', { round: 1 }), file('Final', { round: 1 })];
    renderWithProviders(<DealFilesPanel deal={deal()} />);
    await expect.element(deliver()).toBeDisabled();
  });

  test('an offering with no preview needs only a final', async () => {
    mocks.files = [file('Final')];
    renderWithProviders(<DealFilesPanel deal={deal('None')} />);
    await expect.element(deliver()).toBeEnabled();
  });
});
