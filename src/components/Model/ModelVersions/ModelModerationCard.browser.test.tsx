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

    const latest = page.getByText(/Latest scan · complete/);
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

  test('badges an upheld appeal beside the open badge', async () => {
    mocks.data = {
      ...base,
      textScanFlags: [{ ...poiVerdict, appealUpheld: { at: '2026-09-03T00:00:00.000Z', by: 4 } }],
    };
    renderWithProviders(<ModelModerationCard modelId={7} />);
    await openCard();

    await expect.element(page.getByText('Appeal upheld')).toBeInTheDocument();
    await expect.element(page.getByText('Open', { exact: true })).toBeInTheDocument();
  });

  test('counts an open verdict once alongside its flag badge, and a closed one not at all', async () => {
    mocks.data = {
      ...base,
      textScan: null,
      textScanFlags: [poiVerdict, { ...poiVerdict, label: 'minor', open: false }],
    };
    renderWithProviders(<ModelModerationCard modelId={7} />);

    const control = page.getByRole('button', { name: /Moderation/ });
    await expect.element(control).toBeInTheDocument();
    expect(control.element().textContent).toMatch(/^Moderation1mods only$/);
  });

  test('counts an open verdict whose flag badge is not shown', async () => {
    mocks.data = { ...base, poi: false, textScan: null, textScanFlags: [poiVerdict] };
    renderWithProviders(<ModelModerationCard modelId={7} />);

    const control = page.getByRole('button', { name: /Moderation/ });
    await expect.element(control).toBeInTheDocument();
    expect(control.element().textContent).toMatch(/^Moderation1mods only$/);
  });

  test('a verdict alone keeps the card out of its empty state', async () => {
    mocks.data = { ...base, poi: false, textScan: null, textScanFlags: [poiVerdict] };
    renderWithProviders(<ModelModerationCard modelId={7} />);
    await openCard();

    await expect.element(page.getByText(/Flagged by text scan · poi/)).toBeInTheDocument();
    expect(page.getByText('No moderation flags on this model').elements()).toHaveLength(0);
  });
});

describe('ModelModerationCard — latest scan per label', () => {
  const labelVerdict = {
    label: 'poi',
    detected: false,
    reason: 'No real person named.',
    source: 'web search',
    status: 'Succeeded',
    updatedAt: new Date('2026-10-02T00:00:00Z'),
  };
  const withVerdict = (overrides: Record<string, unknown>) => ({
    ...base,
    textScan: { ...base.textScan, labelVerdicts: [{ ...labelVerdict, ...overrides }] },
  });

  test('shows where each poi/minor verdict came from', async () => {
    mocks.data = withVerdict({});
    renderWithProviders(<ModelModerationCard modelId={7} />);
    await openCard();

    await expect
      .element(page.getByText(/not detected — No real person named\./))
      .toBeInTheDocument();
    await expect.element(page.getByText(/^web search · /)).toBeInTheDocument();
    expect(page.getByText(/Latest scan · Succeeded/).elements()).toHaveLength(0);
    await expect.element(page.getByText(/Latest scan · complete/)).toBeInTheDocument();
    expect(page.getByText(/No real person named\./).elements()).toHaveLength(1);
  });

  test('says no verdict when the verdict carries no boolean detected', async () => {
    mocks.data = withVerdict({ detected: null });
    renderWithProviders(<ModelModerationCard modelId={7} />);
    await openCard();

    await expect.element(page.getByText(/no verdict — No real person named\./)).toBeInTheDocument();
  });

  test('says a rescan is pending instead of dating the last verdict', async () => {
    mocks.data = withVerdict({ source: 'main', status: 'Pending' });
    renderWithProviders(<ModelModerationCard modelId={7} />);
    await openCard();

    await expect
      .element(page.getByText('main scan · rescan pending — last verdict shown'))
      .toBeInTheDocument();
  });

  test('says the last rescan failed instead of dating the last verdict', async () => {
    mocks.data = withVerdict({ status: 'Expired' });
    renderWithProviders(<ModelModerationCard modelId={7} />);
    await openCard();

    await expect
      .element(page.getByText('web search · last rescan failed — last verdict shown'))
      .toBeInTheDocument();
  });
});
