// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pickFooterTakeover } from '~/components/generation_v2/FooterTermsGate';
import { getGenerationLicenseTerms } from '~/shared/constants/generation-license.constants';
import type * as TrpcModule from '~/utils/trpc';

const mocks = vi.hoisted(() => ({
  session: { type: 'authed' } as { type: string } | null,
  acceptances: {} as Record<string, { version: number; acceptedAt: string }>,
  getSettings: vi.fn(),
  accept: vi.fn(),
}));

vi.mock('~/components/CivitaiWrapped/CivitaiSessionProvider', () => ({
  useOptionalCivitaiSessionContext: () => mocks.session,
}));
vi.mock('~/utils/trpc', async (importOriginal) => ({
  ...(await importOriginal<typeof TrpcModule>()),
  trpcVanilla: {
    user: { getSettings: { query: mocks.getSettings } },
    orchestrator: { acceptGenerationLicense: { mutate: mocks.accept } },
  },
}));

const { useGenerationLicenseFor } = await import(
  '~/components/form-graph/generation/useGenerationLicense'
);

const h3Terms = getGenerationLicenseTerms('MiniMaxH3Image')!;
const open = {
  available: true,
  selfHostedBlocked: false,
  termsReviewed: true,
  licenseBlocked: false,
  membershipNeedsAcknowledgment: false,
};

describe('pickFooterTakeover', () => {
  it('shows the form controls only when nothing owns the footer', () => {
    expect(pickFooterTakeover(open)).toBeUndefined();
  });

  it('Generation Terms blocks until reviewed, ahead of the licence and the upsell', () => {
    expect(
      pickFooterTakeover({
        ...open,
        termsReviewed: false,
        licenseBlocked: true,
        membershipNeedsAcknowledgment: true,
      })
    ).toBe('generationTerms');
  });

  it('the licence follows Generation Terms and comes before the upsell', () => {
    expect(
      pickFooterTakeover({ ...open, licenseBlocked: true, membershipNeedsAcknowledgment: true })
    ).toBe('generationLicense');
  });

  it('an unavailable generator or a self-hosted block wins over both terms panels', () => {
    const unreviewed = { ...open, termsReviewed: false, licenseBlocked: true };
    expect(pickFooterTakeover({ ...unreviewed, available: false })).toBe('unavailable');
    expect(pickFooterTakeover({ ...unreviewed, available: false, selfHostedBlocked: true })).toBe(
      'unavailable'
    );
    expect(pickFooterTakeover({ ...unreviewed, selfHostedBlocked: true })).toBe(
      'selfHostedBlocked'
    );
  });
});

describe('useGenerationLicenseFor', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let latest: ReturnType<typeof useGenerationLicenseFor>;

  async function render(ecosystem: string | undefined) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Probe() {
      latest = useGenerationLicenseFor(ecosystem);
      return null;
    }
    await act(async () => {
      root.render(createElement(QueryClientProvider, { client }, createElement(Probe)));
    });
    // Let the settings query settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.session = { type: 'authed' };
    mocks.acceptances = {};
    mocks.getSettings.mockReset().mockImplementation(async () => ({
      generationLicenseAcceptances: { ...mocks.acceptances },
    }));
    mocks.accept.mockReset().mockImplementation(async () => {
      mocks.acceptances[h3Terms.key] = {
        version: h3Terms.version,
        acceptedAt: new Date().toISOString(),
      };
    });
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
  });

  it('blocks a signed-in user on H3 until they accept, then clears', async () => {
    await render('MiniMaxH3Image');
    expect(latest.blocked).toBe(true);
    expect(latest.terms?.key).toBe(h3Terms.key);

    await act(async () => {
      latest.accept();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(mocks.accept).toHaveBeenCalledWith({ ecosystem: 'MiniMaxH3Image' });
    expect(latest.blocked).toBe(false);
  });

  it('does not block a signed-in user who already accepted the current version', async () => {
    mocks.acceptances[h3Terms.key] = { version: h3Terms.version, acceptedAt: '2026-11-11' };
    await render('MiniMaxH3Image');
    expect(latest.blocked).toBe(false);
  });

  it('does not block when signed out: the sign-in gate comes first', async () => {
    mocks.session = null;
    await render('MiniMaxH3Image');
    expect(latest.blocked).toBe(false);
    expect(mocks.getSettings).not.toHaveBeenCalled();
  });

  it('does not flash the panel at a user who accepted while their settings load', async () => {
    let resolve!: (v: unknown) => void;
    mocks.getSettings.mockImplementation(() => new Promise((r) => (resolve = r)));
    await render('MiniMaxH3Image');
    expect(latest.blocked).toBe(false);

    await act(async () => {
      resolve({
        generationLicenseAcceptances: {
          [h3Terms.key]: { version: h3Terms.version, acceptedAt: '2026-11-11' },
        },
      });
    });
    expect(latest.blocked).toBe(false);
  });

  it('costs nothing for an ecosystem without terms', async () => {
    await render('SDXL');
    expect(latest.blocked).toBe(false);
    expect(mocks.getSettings).not.toHaveBeenCalled();
  });
});
