import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import { makeTrpcProxy } from '../../../../test/trpcProxyStub';
import type * as TrpcModule from '~/utils/trpc';

const mocks = vi.hoisted(() => ({ data: null as Record<string, unknown> | null }));

vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  // Three levels deep: the stub keys `router.proc`, so `models` is the procedure node here.
  trpc: makeTrpcProxy({
    'moderator.models': {
      getModerationDetail: { useQuery: () => ({ data: mocks.data, isLoading: false }) },
    },
  }),
}));

const { ModelModerationCard } = await import('./ModelModerationCard');

const base = {
  id: 7,
  name: 'm',
  nsfw: false,
  nsfwLevel: 1,
  status: 'Published',
  availability: 'Public',
  minor: false,
  poi: true,
  lockedProperties: [],
  cannotPromote: false,
  cannotPublish: false,
  commentsLocked: false,
  deletedAt: null,
  deletedBy: null,
  profanity: null,
  textModeration: null,
  textScan: {
    status: 'Succeeded',
    nsfwLevel: null,
    triggeredLabels: [],
    reasons: [{ label: 'poi', reason: 'No real person named.' }],
    updatedAt: new Date('2026-10-02T00:00:00Z'),
  },
  textScanFlags: [] as unknown[],
  unpublishedAt: null,
  unpublishedBy: null,
  unpublishedReason: null,
  takenDownAt: null,
  takenDownBy: null,
  needsReview: false,
};

const poiVerdict = {
  label: 'poi',
  reason: 'Names a real actor.',
  names: ['Jane Doe'],
  at: '2026-09-01T00:00:00.000Z',
  workflowId: 'wf-poi-123',
  model: 'llm-1',
  appealGranted: null,
  appealUpheld: null,
  open: true,
};

const openCard = async () => {
  await page.getByRole('button', { name: /Moderation/ }).click();
};

beforeEach(() => {
  try {
    localStorage.removeItem('model-moderation-card');
  } catch {}
});

describe('ModelModerationCard — text-scan flag verdicts', () => {
  test('shows the verdict that set a sticky flag above the latest scan', async () => {
    mocks.data = { ...base, textScanFlags: [poiVerdict] };
    renderWithProviders(<ModelModerationCard modelId={7} />);
    await openCard();

    const flagged = page.getByText(/Flagged by text scan · poi/);
    await expect.element(flagged).toBeInTheDocument();
    await expect.element(page.getByText('Names a real actor.')).toBeInTheDocument();
    await expect.element(page.getByText('Jane Doe')).toBeInTheDocument();
    await expect.element(page.getByText(/wf-poi-123/)).toBeInTheDocument();
    await expect.element(page.getByText(/llm-1/)).toBeInTheDocument();
    await expect.element(page.getByText('Open', { exact: true })).toBeInTheDocument();

    const latest = page.getByText(/Latest scan · Succeeded/);
    await expect.element(latest).toBeInTheDocument();
    expect(
      flagged.element().compareDocumentPosition(latest.element()) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  test('badges a granted appeal and drops the open badge', async () => {
    mocks.data = {
      ...base,
      textScanFlags: [
        { ...poiVerdict, open: false, appealGranted: { at: '2026-09-03T00:00:00.000Z', by: 4 } },
      ],
    };
    renderWithProviders(<ModelModerationCard modelId={7} />);
    await openCard();

    await expect.element(page.getByText('Appeal granted')).toBeInTheDocument();
    expect(page.getByText('Open', { exact: true }).elements()).toHaveLength(0);
  });

  test('a verdict alone keeps the card out of its empty state', async () => {
    mocks.data = { ...base, poi: false, textScan: null, textScanFlags: [poiVerdict] };
    renderWithProviders(<ModelModerationCard modelId={7} />);
    await openCard();

    await expect.element(page.getByText(/Flagged by text scan · poi/)).toBeInTheDocument();
    expect(page.getByText('No moderation flags on this model').elements()).toHaveLength(0);
  });
});
