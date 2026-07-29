import { describe, it, expect, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { useRouter } from 'next/router';
import { renderWithProviders } from '../../../../test/component-setup';

// The current user is the only input that gates the redirect. A `vi.hoisted`
// holder lets the (hoisted) `vi.mock` factory read a value the tests mutate.
const mocks = vi.hoisted(() => ({
  currentUser: undefined as { customerId?: string; refresh?: () => void } | undefined,
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mocks.currentUser,
}));

// Trim the leaf components that need app-level context / edge config we don't
// exercise here — the test is about the redirect guard, not the success chrome.
vi.mock('~/components/Meta/Meta', () => ({ Meta: () => null }));
vi.mock('~/components/EdgeMedia/EdgeMedia', () => ({ EdgeMedia: () => null }));
vi.mock('~/components/NextLink/NextLink', () => ({
  NextLink: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
}));

import PaymentSuccess from '~/pages/payment/success';

// The scaffold mocks `next/router` with a shared router object (spy `replace`,
// mutable `query`). Grab it so we can seed `cid` and assert on `replace`.
const router = useRouter();

function setup({ cid, customerId }: { cid?: string; customerId?: string }) {
  (router.query as { cid?: string }).cid = cid;
  mocks.currentUser = customerId ? { customerId, refresh: vi.fn() } : { refresh: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  (router.query as { cid?: string }).cid = undefined;
  mocks.currentUser = undefined;
});

describe('PaymentSuccess', () => {
  it('renders the success content without navigating during render for an anonymous/undefined user (SSR condition)', async () => {
    // On the server / before the user hydrates, `customerId` is undefined. The
    // old render-body guard (`if (cid !== customerId?.slice(-8)) router.replace(...)`)
    // fired here and called `router.replace` during render — which throws
    // "No router instance found" on the server → the page 500s. This is the
    // regression test: the render must be pure (no navigation) and must render
    // the neutral success shell instead.
    setup({ cid: 'abcd1234', customerId: undefined });

    renderWithProviders(<PaymentSuccess />);

    await expect.element(page.getByText('Payment Complete!')).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('redirects a signed-in user whose customer id suffix does not match cid (client-side, from an effect)', async () => {
    setup({ cid: 'ZZZZ0000', customerId: 'cus_live_abcd1234' }); // suffix `abcd1234` !== `ZZZZ0000`

    renderWithProviders(<PaymentSuccess />);

    await vi.waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/');
    });
  });

  it('does not redirect when the cid matches the customer id suffix', async () => {
    setup({ cid: 'abcd1234', customerId: 'cus_live_abcd1234' }); // suffix matches cid

    renderWithProviders(<PaymentSuccess />);

    await expect.element(page.getByText('Payment Complete!')).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('does not redirect an anonymous user even when cid is present', async () => {
    setup({ cid: 'abcd1234', customerId: undefined });

    renderWithProviders(<PaymentSuccess />);

    await expect.element(page.getByText('Payment Complete!')).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });
});
