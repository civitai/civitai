import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
// `test/` lives outside `src`, so the `~` alias doesn't reach it — relative import.
import { renderWithProviders } from '../../../test/component-setup';

/**
 * F-E marketplace REVIEWS — component tests for the user-facing review UI.
 *
 * Two load-bearing behaviours, both network-free (tRPC mocked via the scaffold's
 * documented `vi.mock('~/utils/trpc')` pattern):
 *
 *   1. The write form calls `blocks.upsertReview` with the rating + details the
 *      user entered (the form↔backend wiring).
 *   2. The list renders `details` as ESCAPED PLAIN TEXT — an HTML/script string
 *      in `details` appears verbatim as text and is NOT parsed into DOM (no
 *      injected element, no script execution). This guards the audit MEDIUM
 *      (details is unsanitized server-side; React escaping is the control).
 */

// Hoisted, per-test-controllable mock impls (vi.mock is hoisted above imports).
const mocks = vi.hoisted(() => ({
  upsert: vi.fn(),
  invalidate: vi.fn().mockResolvedValue(undefined),
  listItems: [] as Array<{
    id: number;
    userId: number;
    rating: number;
    recommended: boolean;
    details: string | null;
    createdAt: Date;
  }>,
  myReview: null as null | {
    id: number;
    userId: number;
    rating: number;
    recommended: boolean;
    details: string | null;
    createdAt: Date;
  },
  // Per-test-controllable current user (null = anonymous viewer).
  currentUser: { id: 42, username: 'viewer' } as null | { id: number; username: string },
}));

vi.mock('~/utils/trpc', () => ({
  trpc: {
    blocks: {
      getMyReview: {
        useQuery: () => ({ data: mocks.myReview, isLoading: false }),
      },
      upsertReview: {
        useMutation: ({ onSuccess }: { onSuccess?: (r: unknown) => void } = {}) => ({
          mutate: (input: unknown) => {
            mocks.upsert(input);
            onSuccess?.({ review: { id: 1 }, isFirstReview: true });
          },
          isPending: false,
        }),
      },
      listReviews: {
        useInfiniteQuery: () => ({
          data: { pages: [{ items: mocks.listItems, nextCursor: undefined }] },
          isLoading: false,
          fetchNextPage: vi.fn(),
          hasNextPage: false,
          isFetchingNextPage: false,
        }),
      },
    },
    useUtils: () => ({
      blocks: {
        getMyReview: { invalidate: mocks.invalidate },
        listReviews: { invalidate: mocks.invalidate },
        getAppDetail: { invalidate: mocks.invalidate },
      },
    }),
  },
}));

// Feature flag + current user: the form gate is supplied by the CALLER
// (subscriptions prop) here, so just make the flag on and a signed-in user.
vi.mock('~/providers/FeatureFlagsProvider', () => ({
  useFeatureFlags: () => ({ appBlocks: true }),
}));
vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mocks.currentUser,
}));

// LoginRedirect pulls in the router + tour context; it's a pass-through wrapper
// for the sign-in CTA here — stub it to render its child unchanged.
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: React.ReactElement }) => children,
}));

// UserAvatar pulls in edge-url/cosmetics machinery we don't need here — stub it
// to a plain element so the list rows render network-free.
vi.mock('~/components/UserAvatar/UserAvatar', () => ({
  UserAvatar: ({ userId }: { userId: number }) => <span>user-{userId}</span>,
}));

// Notifications are side-effects; stub them out.
vi.mock('~/utils/notifications', () => ({
  showSuccessNotification: vi.fn(),
  showErrorNotification: vi.fn(),
}));

// DaysFromNow needs the IsClientProvider context (not under test) — stub it.
vi.mock('~/components/Dates/DaysFromNow', () => ({
  DaysFromNow: ({ date }: { date: Date }) => <span>{date.toISOString()}</span>,
}));

// Import AFTER the mocks are declared (vi.mock is hoisted, imports are not).
const { AppBlockReviews } = await import('./AppBlockReviews');

const ENABLED_SUB = {
  id: 'sub-1',
  appBlockId: 'app-1',
  enabled: true,
} as never;

beforeEach(() => {
  mocks.upsert.mockClear();
  mocks.invalidate.mockClear();
  mocks.listItems = [];
  mocks.myReview = null;
  mocks.currentUser = { id: 42, username: 'viewer' };
});

describe('AppBlockReviews', () => {
  test('signed-in viewer with an enabled install sees the write form (not the prompt)', async () => {
    renderWithProviders(
      <AppBlockReviews
        appBlockId="app-1"
        avgRating={null}
        reviewCount={0}
        subscriptions={[ENABLED_SUB]}
      />
    );

    // The form is present...
    await expect.element(page.getByRole('button', { name: /post review/i })).toBeInTheDocument();
    // ...and neither gating prompt is shown.
    await expect
      .element(page.getByText(/install this app to leave a review/i))
      .not.toBeInTheDocument();
    await expect.element(page.getByText(/sign in to leave a review/i)).not.toBeInTheDocument();
  });

  test('signed-in viewer with NO enabled install sees the install prompt, form hidden', async () => {
    renderWithProviders(
      <AppBlockReviews appBlockId="app-1" avgRating={null} reviewCount={0} subscriptions={[]} />
    );

    // The install prompt is shown...
    await expect
      .element(page.getByText(/install this app to leave a review/i))
      .toBeInTheDocument();
    // ...and the write form is NOT rendered.
    await expect
      .element(page.getByRole('button', { name: /post review/i }))
      .not.toBeInTheDocument();
  });

  test('anonymous viewer sees the sign-in prompt, form hidden', async () => {
    mocks.currentUser = null;

    renderWithProviders(
      <AppBlockReviews appBlockId="app-1" avgRating={null} reviewCount={0} subscriptions={[]} />
    );

    // The sign-in affordance is shown...
    await expect.element(page.getByText(/sign in to leave a review/i)).toBeInTheDocument();
    await expect.element(page.getByRole('button', { name: /^sign in$/i })).toBeInTheDocument();
    // ...and neither the write form nor the install prompt are rendered.
    await expect
      .element(page.getByRole('button', { name: /post review/i }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByText(/install this app to leave a review/i))
      .not.toBeInTheDocument();
  });

  test('write form submits upsertReview with the entered rating and details', async () => {
    renderWithProviders(
      <AppBlockReviews
        appBlockId="app-1"
        avgRating={null}
        reviewCount={0}
        subscriptions={[ENABLED_SUB]}
      />
    );

    // Wait for the form to mount, then pick 4 stars. Mantine Rating renders a
    // (visually-hidden, 0-size) radio input per star value with the change
    // handler on its OVERLAID <label> (the visible star). The hidden input
    // fails Playwright's visibility gate and a raw click on it doesn't reach
    // React's controlled onChange, so click the associated <label> (carries
    // `onClick={() => onChange(4)}`) directly.
    const fourStarsLocator = page.getByRole('radio', { name: '4' });
    await expect.element(fourStarsLocator).toBeInTheDocument();
    const fourStars = fourStarsLocator.element() as HTMLInputElement;
    const label = document.querySelector<HTMLLabelElement>(`label[for="${fourStars.id}"]`);
    expect(label).not.toBeNull();
    label!.click();

    // Type details.
    const textarea = page.getByRole('textbox');
    await textarea.fill('Great app, very useful');

    await page.getByRole('button', { name: /post review/i }).click();

    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        appBlockId: 'app-1',
        rating: 4,
        details: 'Great app, very useful',
      })
    );
    // Success path invalidates the list + summary + my-review queries.
    expect(mocks.invalidate).toHaveBeenCalled();
  });

  test('renders review rows and escapes HTML in details (no injected element / script)', async () => {
    const hostile = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>hello';
    mocks.listItems = [
      {
        id: 7,
        userId: 99,
        rating: 5,
        recommended: true,
        details: hostile,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ];

    renderWithProviders(
      <AppBlockReviews
        appBlockId="app-1"
        avgRating={5}
        reviewCount={1}
        subscriptions={[]}
      />
    );

    // The hostile string is present verbatim as TEXT.
    await expect.element(page.getByText(hostile, { exact: false })).toBeInTheDocument();

    // It was NOT parsed into DOM: the <img src=x>/<script> from `details` never
    // became real elements, and their side-effects never ran.
    expect(document.querySelector('img[src="x"]')).toBeNull();
    const scriptWithPayload = Array.from(document.querySelectorAll('script')).some((s) =>
      s.textContent?.includes('__pwned')
    );
    expect(scriptWithPayload).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((window as any).__pwned).toBeUndefined();
  });
});
