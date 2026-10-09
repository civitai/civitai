import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type * as TrpcMod from '~/utils/trpc';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * "Send feedback to developer" — the chrome entry point and its modal, mounted through the real
 * `AppBlockChrome` (as `ChromeReviewEntry.browser.test.tsx` does) so the seam is under test: the
 * chrome derives the request from its props, owns the modal state, and the item closes its
 * opener. The tRPC query is backed by real React Query with a counting `queryFn`, so a fetch
 * count is a count of requests, not of hook calls.
 */

type Eligibility =
  | { eligible: false }
  | { eligible: true; appListingId: string; appName: string; appBlockVersion: string | null };

const mocks = vi.hoisted(() => ({
  features: { appListings: true } as Record<string, boolean>,
  user: { id: 7, username: 'viewer', isModerator: false } as unknown,
  eligibility: null as unknown,
  eligibilityInputs: [] as unknown[],
  createInputs: [] as unknown[],
  createResult: { kind: 'ok' } as { kind: 'ok' } | { kind: 'error'; message: string; code: string },
  /** When set, `create` waits on this before settling — holds the mutation pending. */
  createGate: null as Promise<void> | null,
  /** `getAppDetail`'s answer — read only by the ⋮ menu's existing review item. */
  detail: null as unknown,
}));

vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.user }));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsMod>()),
  useFeatureFlags: () => mocks.features,
  useOptionalFeatureFlags: () => mocks.features,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const { useMutation, useQuery } = await import('@tanstack/react-query');
  return {
    ...(await importOriginal<typeof TrpcMod>()),
    trpc: makeTrpcProxy(
      {
        'appFeedback.getEligibility': {
          useQuery: (input: unknown, opts?: Record<string, unknown>) =>
            useQuery({
              queryKey: [['appFeedback', 'getEligibility'], { input, type: 'query' }],
              queryFn: async () => {
                mocks.eligibilityInputs.push(input);
                return mocks.eligibility;
              },
              ...opts,
            }),
        },
        'appFeedback.create': {
          useMutation: () =>
            useMutation({
              mutationFn: async (input: unknown) => {
                mocks.createInputs.push(input);
                if (mocks.createGate) await mocks.createGate;
                const result = mocks.createResult;
                if (result.kind === 'error')
                  throw Object.assign(new Error(result.message), { data: { code: result.code } });
                return { id: 1 };
              },
            }),
        },
        'appListings.getAppDetail': {
          useQuery: (input: unknown, opts?: Record<string, unknown>) =>
            useQuery({
              queryKey: [['appListings', 'getAppDetail'], { input, type: 'query' }],
              queryFn: async () => mocks.detail,
              ...opts,
            }),
        },
        'appListings.getMyReview': {
          useQuery: (input: unknown, opts?: Record<string, unknown>) =>
            useQuery({
              queryKey: [['appListings', 'getMyReview'], { input, type: 'query' }],
              queryFn: async () => null,
              ...opts,
            }),
        },
      },
      {
        useUtils: () => ({
          blocks: { listMyScopeGrants: { invalidate: vi.fn(async () => undefined) } },
        }),
      }
    ),
  };
});

// eslint-disable-next-line import/first
import { AppBlockChrome } from '~/components/AppBlocks/IframeHost';
// eslint-disable-next-line import/first
import { trpc } from '~/utils/trpc';

const APP_NAME = 'Budgeted Generator';
const SLUG = 'budgeted-generator';
const APP_BLOCK_ID = 'ab_01HZ';
const MODEL_ID = 31337;

function eligible(over: Partial<Extract<Eligibility, { eligible: true }>> = {}): Eligibility {
  return {
    eligible: true,
    appListingId: 'apl_01HZ',
    appName: 'Pixel Forge',
    appBlockVersion: '1.4.2',
    ...over,
  };
}

function ProdishProviders({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { refetchOnWindowFocus: false, retry: false, staleTime: Infinity },
          mutations: { retry: false },
        },
      })
  );
  return (
    <QueryClientProvider client={queryClient}>
      <MantineProvider>{children}</MantineProvider>
    </QueryClientProvider>
  );
}

/** Page host: what `PageBlockHost` passes. */
const PAGE_PROPS = { appBlockId: APP_BLOCK_ID, slug: SLUG, slotId: 'app.page' };
/** Model slot: what `IframeHost` passes — no slug, a model id. */
const SLOT_PROPS = { appBlockId: APP_BLOCK_ID, slotId: 'model.sidebar_top', modelId: MODEL_ID };

/**
 * A second observer of the eligibility query that renders a marker once it has resolved, so an
 * "item absent" assertion is made AFTER the data landed rather than passing at t0 because nothing
 * has arrived yet. It shares the key, so it adds no request.
 */
function EligibilityProbe({ target }: { target: Record<string, string> }) {
  const { data } = trpc.appFeedback.getEligibility.useQuery({ target } as never, { retry: false });
  return data ? <span data-testid="eligibility-probe-resolved" /> : null;
}

function renderChrome(
  props: Record<string, unknown> = PAGE_PROPS,
  probeTarget?: Record<string, string>
) {
  return render(
    <>
      <AppBlockChrome blockInstanceId="inst-fb" appName={APP_NAME} {...props} />
      {probeTarget && <EligibilityProbe target={probeTarget} />}
    </>,
    { wrapper: ProdishProviders }
  );
}

async function openOverflow() {
  await page.getByTestId('app-block-menu-trigger').click();
  await expect.element(page.getByTestId('app-block-menu-dropdown')).toBeInTheDocument();
}

const feedbackItem = () => page.getByTestId('app-block-feedback-menu-item');
const modal = () => page.getByTestId('app-feedback-modal');
const messageBox = () => page.getByTestId('app-feedback-message');
const sendButton = () => page.getByTestId('app-feedback-submit');

async function openFeedbackModal(props: Record<string, unknown> = PAGE_PROPS) {
  renderChrome(props);
  await openOverflow();
  await expect.element(feedbackItem()).toBeInTheDocument();
  await feedbackItem().click();
  await expect
    .element(page.getByText("Send private feedback to Pixel Forge's developer"))
    .toBeInTheDocument();
}

async function typeAndSend(text: string) {
  await userEvent.fill(messageBox().element() as HTMLElement, text);
  await sendButton().click();
}

beforeEach(async () => {
  mocks.features = { appListings: true };
  mocks.user = { id: 7, username: 'viewer', isModerator: false };
  mocks.eligibility = eligible();
  mocks.eligibilityInputs = [];
  mocks.createInputs = [];
  mocks.createResult = { kind: 'ok' };
  mocks.createGate = null;
  mocks.detail = null;
  await page.viewport(1280, 900);
});

describe('the ⋮ item', () => {
  test('page host: an eligible viewer gets the item, asked of the server by slug', async () => {
    renderChrome();
    await openOverflow();
    await expect.element(feedbackItem()).toHaveTextContent('Send feedback to developer');
    expect(feedbackItem().element().getAttribute('href')).toBeNull();
    expect(mocks.eligibilityInputs).toEqual([{ target: { slug: SLUG } }]);
  });

  test('model slot: the item is offered there too, asked of the server by AppBlock id', async () => {
    renderChrome(SLOT_PROPS);
    await openOverflow();
    await expect.element(feedbackItem()).toBeInTheDocument();
    expect(mocks.eligibilityInputs).toEqual([{ target: { appBlockId: APP_BLOCK_ID } }]);
  });

  test('hidden when the server says not eligible (owner/editor, flag off, …)', async () => {
    mocks.eligibility = { eligible: false };
    renderChrome(PAGE_PROPS, { slug: SLUG });
    await openOverflow();
    await expect.element(page.getByTestId('eligibility-probe-resolved')).toBeInTheDocument();
    expect(mocks.eligibilityInputs).toHaveLength(1);
    expect(feedbackItem().elements()).toHaveLength(0);
  });

  test('CONTROL — the same harness shows it when eligible', async () => {
    renderChrome(PAGE_PROPS, { slug: SLUG });
    await openOverflow();
    await expect.element(page.getByTestId('eligibility-probe-resolved')).toBeInTheDocument();
    await expect.element(feedbackItem()).toBeInTheDocument();
  });

  test('signed out: no item and no eligibility request', async () => {
    mocks.user = null;
    renderChrome();
    await openOverflow();
    await expect.element(page.getByRole('menuitem', { name: 'Manage apps' })).toBeInTheDocument();
    expect(feedbackItem().elements()).toHaveLength(0);
    expect(mocks.eligibilityInputs).toHaveLength(0);
  });

  test('no store access: no item and no eligibility request', async () => {
    mocks.features = {};
    renderChrome();
    await openOverflow();
    await expect.element(page.getByRole('menuitem', { name: 'Manage apps' })).toBeInTheDocument();
    expect(feedbackItem().elements()).toHaveLength(0);
    expect(mocks.eligibilityInputs).toHaveLength(0);
  });

  test('a closed menu issues no eligibility request; opening it issues one', async () => {
    renderChrome();
    await expect.element(page.getByTestId('app-block-menu-trigger')).toBeInTheDocument();
    expect(mocks.eligibilityInputs).toHaveLength(0);
    await openOverflow();
    await expect.element(feedbackItem()).toBeInTheDocument();
    expect(mocks.eligibilityInputs).toHaveLength(1);
  });
});

describe('opening the modal', () => {
  test('the menu closes and the private-feedback modal opens', async () => {
    await openFeedbackModal();
    await expect
      .element(page.getByTestId('app-feedback-private-notice'))
      .toHaveTextContent(
        "Private. Only this app's developer and Civitai moderators can read this."
      );
    await expect
      .element(page.getByTestId('app-feedback-sent-with'))
      .toHaveTextContent('Sent with: app version 1.4.2. Nothing else is collected.');
    await expect
      .element(page.getByRole('menuitem', { name: 'Manage apps' }))
      .not.toBeInTheDocument();
    expect(page.getByTestId('app-block-menu-trigger').element().getAttribute('aria-expanded')).toBe(
      'false'
    );
    // Desktop control for the 375px full-screen test below.
    const content = document.querySelector('.mantine-Modal-content') as HTMLElement | null;
    expect(content).not.toBeNull();
    expect(content?.getAttribute('data-full-screen')).toBeNull();
  });

  test('Send is disabled until there is text', async () => {
    await openFeedbackModal();
    await expect.element(sendButton()).toBeDisabled();
    await userEvent.fill(messageBox().element() as HTMLElement, '   ');
    await expect.element(sendButton()).toBeDisabled();
    await userEvent.fill(messageBox().element() as HTMLElement, 'hello');
    await expect.element(sendButton()).toBeEnabled();
  });
});

describe('submitting', () => {
  test('page host: sends exactly {target: slug, message, context: {surface: page}} and confirms', async () => {
    await openFeedbackModal();
    await typeAndSend('  the export button 404s  ');
    await expect
      .element(page.getByTestId('app-feedback-sent'))
      .toHaveTextContent(
        "Sent to the developer. You'll get a notification if they mark it resolved or won't fix."
      );
    expect(mocks.createInputs).toStrictEqual([
      { target: { slug: SLUG }, message: 'the export button 404s', context: { surface: 'page' } },
    ]);
  });

  test('model slot: sends exactly {target: appBlockId, message, context: {surface: slot, modelId}}', async () => {
    await openFeedbackModal(SLOT_PROPS);
    await expect
      .element(page.getByTestId('app-feedback-sent-with'))
      .toHaveTextContent(
        'Sent with: app version 1.4.2 and the model you were viewing. Nothing else is collected.'
      );
    await typeAndSend('love it');
    await expect.element(page.getByTestId('app-feedback-sent')).toBeInTheDocument();
    expect(mocks.createInputs).toStrictEqual([
      {
        target: { appBlockId: APP_BLOCK_ID },
        message: 'love it',
        context: { surface: 'slot', modelId: MODEL_ID },
      },
    ]);
  });

  const errorCases: Array<[string, string, string, string]> = [
    [
      'per-app daily cap',
      'TOO_MANY_REQUESTS',
      'You have sent this app a lot of feedback today — give it a little while.',
      'You have sent this app a lot of feedback today — give it a little while.',
    ],
    [
      'content filter with blocked links',
      'BAD_REQUEST',
      'Your feedback links to a site that is not allowed: bad.example. Remove the link and try again.',
      'Your feedback links to a site that is not allowed: bad.example. Remove the link and try again.',
    ],
    [
      'not eligible any more',
      'NOT_FOUND',
      'App not found',
      "This app isn't accepting feedback from you right now.",
    ],
    [
      'own app',
      'FORBIDDEN',
      'You cannot send feedback to your own app',
      'You cannot send feedback to your own app',
    ],
  ];

  for (const [name, code, serverMessage, shown] of errorCases) {
    test(`${name} (${code}): readable error, modal stays open, text kept`, async () => {
      mocks.createResult = { kind: 'error', code, message: serverMessage };
      await openFeedbackModal();
      await typeAndSend('my feedback');
      await expect.element(page.getByTestId('app-feedback-error')).toHaveTextContent(shown);
      await expect.element(modal()).toBeInTheDocument();
      expect((messageBox().element() as HTMLTextAreaElement).value).toBe('my feedback');
      expect(page.getByTestId('app-feedback-sent').elements()).toHaveLength(0);
    });
  }
});

describe('the ⋮ menu on the page host', () => {
  // A listing the ⋮ review item will offer review for (signed in, not the owner, onsite).
  const reviewableDetail = {
    id: 'apl_DETAIL',
    slug: SLUG,
    name: APP_NAME,
    kind: 'onsite',
    creator: { id: 4242, username: 'publisher', image: null },
    recommend: { recommendedCount: 0, notRecommendedCount: 0, recommendPct: null },
    reviewCount: 0,
  };

  test('page host: the ⋮ menu renders both "Rate this app" and "Send feedback to developer"', async () => {
    mocks.detail = reviewableDetail;
    renderChrome();
    await openOverflow();
    await expect
      .element(page.getByTestId('app-block-review-menu-item'))
      .toHaveTextContent('Rate this app');
    await expect.element(feedbackItem()).toHaveTextContent('Send feedback to developer');
  });
});

describe('a reused host (app A → app B without remount)', () => {
  const chrome = (slug: string) => (
    <AppBlockChrome blockInstanceId="inst-fb" appName={APP_NAME} {...PAGE_PROPS} slug={slug} />
  );

  test('the open modal still sends to the app it was opened for', async () => {
    const view = await render(chrome('app-a'), { wrapper: ProdishProviders });
    await openOverflow();
    await expect.element(feedbackItem()).toBeInTheDocument();
    await feedbackItem().click();
    await expect.element(modal()).toBeInTheDocument();
    // Same element type at the same position, so React updates props rather than remounting —
    // the modal staying open is what shows it.
    await view.rerender(chrome('app-b'));
    await expect.element(modal()).toBeInTheDocument();
    await typeAndSend('about app A');
    await expect.element(page.getByTestId('app-feedback-sent')).toBeInTheDocument();
    expect(mocks.createInputs).toStrictEqual([
      { target: { slug: 'app-a' }, message: 'about app A', context: { surface: 'page' } },
    ]);
  });
});

describe('while a submit is pending', () => {
  test('a second Send is ignored and the modal cannot be dismissed', async () => {
    let release: () => void = () => undefined;
    mocks.createGate = new Promise<void>((r) => {
      release = r;
    });
    await openFeedbackModal();
    await userEvent.fill(messageBox().element() as HTMLElement, 'hello');
    await sendButton().click();
    await vi.waitFor(() => expect(mocks.createInputs).toHaveLength(1));
    // DOM clicks, not userEvent: these controls are expected to be disabled while pending. A
    // loading Mantine Button is disabled, so this pins the disabled Send, not `submit`'s own guard.
    (sendButton().element() as HTMLButtonElement).click();
    await userEvent.keyboard('{Escape}');
    const cancel = page.getByRole('button', { name: 'Cancel' });
    await expect.element(cancel).toBeDisabled();
    (cancel.element() as HTMLButtonElement).click();
    await expect.element(modal()).toBeInTheDocument();
    expect(mocks.createInputs).toHaveLength(1);

    release();
    await expect.element(page.getByTestId('app-feedback-sent')).toBeInTheDocument();
    expect(mocks.createInputs).toHaveLength(1);
  });
});

describe('the mobile bottom sheet', () => {
  test('at 375px the item is in the sheet, the sheet closes, and the modal is full-screen', async () => {
    await page.viewport(375, 720);
    renderChrome();
    const root = page.getByTestId('app-block-chrome');
    await expect.element(root).toBeInTheDocument();
    await vi.waitFor(() =>
      expect((root.element() as HTMLElement).getAttribute('data-chrome-compact')).toBe('true')
    );
    await openOverflow();
    await expect.element(feedbackItem()).toBeInTheDocument();
    // A sheet row is a button, not a menuitem.
    expect(feedbackItem().element().getAttribute('role')).not.toBe('menuitem');
    await feedbackItem().click();
    await expect.element(modal()).toBeInTheDocument();
    await expect.element(page.getByTestId('app-block-menu-dropdown')).not.toBeInTheDocument();
    const content = document.querySelector('.mantine-Modal-content') as HTMLElement | null;
    expect(content?.getAttribute('data-full-screen')).toBe('true');
  });
});
