import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';
import type { AvailableBlock } from '~/server/schema/blocks/subscription.schema';

/**
 * App Blocks marketplace CARD — off-site (external-link) app coverage (PURE
 * EXTERNAL LINK).
 *
 * When `block.externalUrl` is set the card:
 *   - renders an "Open ↗" link to the external URL with target=_blank +
 *     rel="noopener noreferrer",
 *   - HIDES the Install / Manage button (an external app has no install),
 *   - shows an "Off-site" badge so the off-platform nature is visually clear,
 *   - keeps the universal "View details" affordance.
 * A normal on-platform app (externalUrl=null) is unchanged.
 */

vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: React.ReactElement }) => children,
}));

const detailsModalSpy = vi.fn();
vi.mock('~/components/Apps/AppDetailsModal', () => ({
  AppDetailsModal: ({ opened, block }: { opened: boolean; block: { id: string } }) => {
    detailsModalSpy({ opened, blockId: block.id });
    return opened ? <div data-testid="details-modal">details for {block.id}</div> : null;
  },
}));

const { AppBlockCard } = await import('./AppBlockCard');

function makeExternalBlock(overrides: Partial<AvailableBlock> = {}): AvailableBlock {
  return {
    id: 'app-ext',
    blockId: 'ext-app',
    appId: 'app-ext',
    appName: 'Ext App',
    manifest: { name: 'Ext App', description: 'An off-site app.' },
    installCount: 0,
    category: null,
    scopesSummary: [],
    externalUrl: 'https://example.com/launch',
    avgRating: null,
    reviewCount: 0,
    coverUrl: null,
    ...overrides,
  };
}

/** A normal on-platform model-slot block (externalUrl null). */
function makeModelBlock(overrides: Partial<AvailableBlock> = {}): AvailableBlock {
  return {
    id: 'app-1',
    blockId: 'my-block',
    appId: 'app-1',
    appName: 'My App',
    manifest: { name: 'My App', targets: [{ slotId: 'model.sidebar_top' }] },
    installCount: 3,
    category: null,
    scopesSummary: [],
    externalUrl: null,
    avgRating: null,
    reviewCount: 0,
    coverUrl: null,
    ...overrides,
  };
}

const onOpen = vi.fn();

beforeEach(() => {
  onOpen.mockClear();
  detailsModalSpy.mockClear();
});

describe('AppBlockCard — external-link (off-site) app', () => {
  test('renders an "Open" link to the external URL (new tab, noopener noreferrer)', async () => {
    renderWithProviders(
      <AppBlockCard block={makeExternalBlock()} alreadySubscribed={false} onOpen={onOpen} />
    );

    const open = page.getByRole('link', { name: /^open$/i });
    await expect.element(open).toBeInTheDocument();
    const el = open.element() as HTMLAnchorElement;
    expect(el.getAttribute('href')).toBe('https://example.com/launch');
    expect(el.getAttribute('target')).toBe('_blank');
    // rel must include both noopener AND noreferrer.
    const rel = el.getAttribute('rel') ?? '';
    expect(rel).toMatch(/noopener/);
    expect(rel).toMatch(/noreferrer/);
  });

  test('HIDES the Install / Manage button for an external app', async () => {
    renderWithProviders(
      <AppBlockCard block={makeExternalBlock()} alreadySubscribed={false} onOpen={onOpen} />
    );
    await expect.element(page.getByRole('link', { name: /^open$/i })).toBeInTheDocument();
    expect(page.getByRole('button', { name: /^install$/i }).query()).toBeNull();
    expect(page.getByRole('button', { name: /^manage$/i }).query()).toBeNull();
  });

  test('HIDES Install even when alreadySubscribed is (erroneously) true', async () => {
    renderWithProviders(
      <AppBlockCard block={makeExternalBlock()} alreadySubscribed onOpen={onOpen} />
    );
    expect(page.getByRole('button', { name: /^manage$/i }).query()).toBeNull();
    expect(page.getByRole('button', { name: /^install$/i }).query()).toBeNull();
  });

  test('shows an "Off-site" badge', async () => {
    renderWithProviders(
      <AppBlockCard block={makeExternalBlock()} alreadySubscribed={false} onOpen={onOpen} />
    );
    await expect.element(page.getByText('Off-site', { exact: true })).toBeInTheDocument();
  });

  test('still renders the universal "View details" affordance', async () => {
    renderWithProviders(
      <AppBlockCard block={makeExternalBlock()} alreadySubscribed={false} onOpen={onOpen} />
    );
    await expect
      .element(page.getByRole('button', { name: /view details/i }))
      .toBeInTheDocument();
  });

  test('a manifest target on an external block does NOT resurrect Install (externalUrl wins)', async () => {
    // Defensive: even if a stray target slipped onto an external block, the
    // external flag suppresses Install.
    renderWithProviders(
      <AppBlockCard
        block={makeExternalBlock({
          manifest: { name: 'Ext', targets: [{ slotId: 'model.sidebar_top' }] },
        })}
        alreadySubscribed={false}
        onOpen={onOpen}
      />
    );
    await expect.element(page.getByRole('link', { name: /^open$/i })).toBeInTheDocument();
    expect(page.getByRole('button', { name: /^install$/i }).query()).toBeNull();
  });
});

describe('AppBlockCard — on-platform app unchanged (no external affordance)', () => {
  test('a model-slot app shows Install, NO "Open" link, NO "Off-site" badge', async () => {
    renderWithProviders(
      <AppBlockCard block={makeModelBlock()} alreadySubscribed={false} onOpen={onOpen} />
    );
    await expect.element(page.getByRole('button', { name: /^install$/i })).toBeInTheDocument();
    // The external "Open" link is a link named exactly "Open" — must be absent.
    expect(page.getByRole('link', { name: /^open$/i }).query()).toBeNull();
    expect(page.getByText('Off-site', { exact: true }).query()).toBeNull();
  });
});
