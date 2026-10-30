import { MantineProvider } from '@mantine/core';
// Real Mantine CSS: the bar-geometry tests below measure the rendered button, and without the
// stylesheet the bar is not a flex row and an ActionIcon is not its resting 22px.
import '@mantine/core/styles.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import type * as FeatureFlagsMod from '~/providers/FeatureFlagsProvider';
import type * as NotificationsMod from '~/utils/notifications';
import type * as TrpcMod from '~/utils/trpc';
import { makeTrpcProxy } from '../../../test/trpcProxyStub';

/**
 * "Send feedback to developer" — the chrome entry point and its modal, mounted through the real
 * `AppBlockChrome` (as `ChromeReviewEntry.browser.test.tsx` does) so the seam is under test: the
 * chrome derives the request from its props, places the button in the bar and owns the modal
 * state. The tRPC query is backed by real React Query with a counting `queryFn`, so a fetch
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
  /** When set, `getEligibility` waits on this before answering — holds the query pending. */
  eligibilityGate: null as Promise<void> | null,
  /** When set, `getEligibility` rejects (e.g. the procedure refused an un-onboarded viewer). */
  eligibilityError: false,
  createInputs: [] as unknown[],
  createResult: { kind: 'ok' } as { kind: 'ok' } | { kind: 'error'; message: string; code: string },
  /** When set, `create` waits on this before settling — holds the mutation pending. */
  createGate: null as Promise<void> | null,
  /** `getAppDetail`'s answer — read only by the ⋮ menu's review item. */
  detail: null as unknown,
  /** Every `showSuccessNotification` message — the toast that replaces the old "sent" screen. */
  successes: [] as unknown[],
}));

vi.mock('~/utils/notifications', async (importOriginal) => ({
  ...(await importOriginal<typeof NotificationsMod>()),
  showSuccessNotification: (toast: { message: unknown; autoClose?: unknown }) =>
    mocks.successes.push({ message: toast.message, autoClose: toast.autoClose }),
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
                if (mocks.eligibilityGate) await mocks.eligibilityGate;
                if (mocks.eligibilityError)
                  throw Object.assign(new Error('Forbidden'), { data: { code: 'FORBIDDEN' } });
                return mocks.eligibility;
              },
              ...opts,
            }),
        },
        'appFeedback.create': {
          // The caller's options pass through, as the real hook's do: the modal's success path
          // (close + toast) is an `onSuccess` option.
          useMutation: (opts?: Record<string, unknown>) =>
            useMutation({
              ...opts,
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
const PAGE_PROPS = {
  appBlockId: APP_BLOCK_ID,
  slug: SLUG,
  slotId: 'app.page',
  hostSurface: 'page-run',
} as const;
/** Model slot: what `IframeHost` passes — no slug, a model id. */
const SLOT_PROPS = {
  appBlockId: APP_BLOCK_ID,
  slotId: 'model.sidebar_top',
  modelId: MODEL_ID,
  hostSurface: 'model-slot',
} as const;

/**
 * A second observer of the eligibility query that renders a marker once it has resolved, so an
 * "item absent" assertion is made AFTER the data landed rather than passing at t0 because nothing
 * has arrived yet. It shares the key, so it adds no request.
 */
function EligibilityProbe({ target }: { target: Record<string, string> }) {
  const { data, isError } = trpc.appFeedback.getEligibility.useQuery({ target } as never, {
    retry: false,
  });
  if (isError) return <span data-testid="eligibility-probe-errored" />;
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

const feedbackButton = () => page.getByTestId('app-block-feedback-button');
/** The retired ⋮ menu item — asserted absent. */
const feedbackMenuItem = () => page.getByTestId('app-block-feedback-menu-item');
const menuTrigger = () => page.getByTestId('app-block-menu-trigger');
const chromeBar = () => page.getByTestId('app-block-chrome').element() as HTMLElement;
const rectOf = (el: Element) => el.getBoundingClientRect();
/** `ActionIcon size="sm"` in @mantine/core 7 — the size of every icon button in the bar. */
const RESTING_ICON_PX = 22;
/** 22 + `py={4}` ×2 + 1px border: the bar's measured resting height (see the mobile-shell suite). */
const CHROME_BAR_RENDERED_PX = 31;

/** The wide-bar form: the visible "Feedback" text beside the icon, at the bar's 22px height. */
function expectLabelled() {
  const el = feedbackButton().element() as HTMLElement;
  expect(el.getAttribute('data-labelled')).toBe('true');
  expect(el.textContent?.trim()).toBe('Feedback');
  const r = rectOf(el);
  expect(r.height).toBe(RESTING_ICON_PX);
  expect(r.width).toBeGreaterThan(RESTING_ICON_PX * 2);
  // The accessible name is the full sentence, which still contains the visible word.
  expect(el.getAttribute('aria-label')).toBe('Send feedback to developer');
}

/**
 * Wait until the bar has been MEASURED narrow. An unmeasured bar renders the wide (labelled) form
 * first and flips once the resize observer fires, so asserting straight after `toBeVisible` would
 * race that flip.
 */
async function waitForIconOnly() {
  await vi.waitFor(() =>
    expect(feedbackButton().element().getAttribute('data-labelled')).toBe('false')
  );
}

/** The narrow-bar form: the bare 22px icon, no visible text. */
function expectIconOnly() {
  const el = feedbackButton().element() as HTMLElement;
  expect(el.getAttribute('data-labelled')).toBe('false');
  expect(el.textContent?.trim()).toBe('');
  const r = rectOf(el);
  expect([r.width, r.height]).toEqual([RESTING_ICON_PX, RESTING_ICON_PX]);
  expect(el.getAttribute('aria-label')).toBe('Send feedback to developer');
}

/** Guard-the-guard: without the stylesheet every measurement below reads as something else. */
function expectStyledOneLineBar() {
  expect(getComputedStyle(chromeBar()).display).toBe('flex');
  expect(Math.round(rectOf(chromeBar()).height)).toBe(CHROME_BAR_RENDERED_PX);
}
const modal = () => page.getByTestId('app-feedback-modal');
const messageBox = () => page.getByTestId('app-feedback-message');
const sendButton = () => page.getByTestId('app-feedback-submit');
const counter = () => page.getByTestId('app-feedback-counter');
const scrim = () => document.querySelector('.mantine-Drawer-overlay') as HTMLElement;
const SENT_MESSAGE =
  "Sent to the developer. You'll get a notification if they mark it resolved or won't fix.";
/** The dialog's own box, desktop (Modal) or phone (Drawer) alike. */
const dialogContent = () =>
  document.querySelector<HTMLElement>('.mantine-Modal-content, .mantine-Drawer-content');

/** Resolves once the modal has gone, with the toast as the only confirmation. */
async function expectClosedWithToast() {
  await expect.element(modal()).not.toBeInTheDocument();
  // 6s, not the helper's 3s default: two sentences, the second said nowhere else.
  expect(mocks.successes).toEqual([{ message: SENT_MESSAGE, autoClose: 6000 }]);
  expect(page.getByText(SENT_MESSAGE).elements()).toHaveLength(0);
}

/**
 * Chromium cannot open a real on-screen keyboard here, so `window.visualViewport` is replaced by
 * a stand-in — the only input the dialog reads. It starts as "no keyboard" for the CURRENT
 * viewport, so call it after `page.viewport(...)`. Restored when the test finishes.
 */
type FakeViewport = EventTarget & { height: number; offsetTop: number };
const realViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
function installFakeViewport(): FakeViewport {
  const fake: FakeViewport = Object.assign(new EventTarget(), {
    height: window.innerHeight,
    offsetTop: 0,
  });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: fake });
  onTestFinished(() => {
    if (realViewport) Object.defineProperty(window, 'visualViewport', realViewport);
    else delete (window as { visualViewport?: unknown }).visualViewport;
  });
  return fake;
}
/** Show a keyboard `px` tall (0 hides it). Returns the y of the visible area's bottom edge. */
function showKeyboard(fake: FakeViewport, px: number): number {
  fake.height = window.innerHeight - px;
  fake.dispatchEvent(new Event('resize'));
  return fake.height;
}
/**
 * Mantine's Textarea turns `autosize` off under test (it renders 2 rows, ~56px), so every
 * geometry assertion would otherwise measure a shorter form than production's 4-row minimum and
 * 10-row maximum. These are those two heights, forced.
 */
const TEXTAREA_4_ROWS_PX = 100;
const TEXTAREA_10_ROWS_PX = 230;
function forceTextareaHeight(px: number) {
  const el = messageBox().element() as HTMLTextAreaElement;
  el.style.height = `${px}px`;
  el.style.minHeight = `${px}px`;
  expect(Math.round(el.getBoundingClientRect().height)).toBe(px);
}
/**
 * With the keyboard's top edge at `visibleBottom`: the whole dialog is inside the visible area,
 * and Send is either visible already or can be scrolled into it inside the dialog.
 */
async function expectSendReachable(visibleBottom: number, { mustScroll }: { mustScroll: boolean }) {
  const box = dialogContent() as HTMLElement;
  await vi.waitFor(() => {
    const r = box.getBoundingClientRect();
    expect(r.top).toBeGreaterThanOrEqual(0);
    expect(r.bottom).toBeLessThanOrEqual(visibleBottom + 1);
  });
  const scrolls = box.scrollHeight > box.clientHeight + 1;
  expect(scrolls).toBe(mustScroll);
  if (scrolls) {
    expect(getComputedStyle(box).overflowY).toBe('auto');
    box.scrollTop = box.scrollHeight;
    expect(box.scrollTop).toBeGreaterThan(0);
  }
  const send = rectOf(sendButton().element());
  expect(send.bottom).toBeLessThanOrEqual(visibleBottom);
  expect(send.top).toBeGreaterThanOrEqual(box.getBoundingClientRect().top);
}

/** The alpha channel of a computed `rgb()`/`rgba()` colour (1 when it has none). */
function alphaOf(color: string): number {
  const parts = color
    .match(/rgba?\(([^)]+)\)/)?.[1]
    .split(',')
    .map((x) => Number(x.trim()));
  if (!parts || parts.length < 3) throw new Error(`not an rgb colour: ${color}`);
  return parts.length === 4 ? parts[3] : 1;
}

/**
 * Wait until the dialog box has stopped moving: Mantine animates both renderings in (the Modal
 * pops, the Drawer slides up), and a rect read mid-transition is neither position.
 */
async function settledDialogRect(): Promise<DOMRect> {
  let last = '';
  let rect: DOMRect | null = null;
  await vi.waitFor(
    () => {
      const el = dialogContent();
      expect(el).not.toBeNull();
      rect = (el as HTMLElement).getBoundingClientRect();
      const key = [rect.top, rect.bottom, rect.left, rect.right].join(',');
      const stable = key === last;
      last = key;
      expect(stable).toBe(true);
    },
    { interval: 100, timeout: 3000 }
  );
  return rect as unknown as DOMRect;
}

async function openFeedbackModal(props: Record<string, unknown> = PAGE_PROPS) {
  renderChrome(props);
  await expect.element(feedbackButton()).toBeInTheDocument();
  await feedbackButton().click();
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
  mocks.eligibilityGate = null;
  mocks.eligibilityError = false;
  mocks.createInputs = [];
  mocks.createResult = { kind: 'ok' };
  mocks.createGate = null;
  mocks.detail = null;
  mocks.successes = [];
  await page.viewport(1280, 900);
});

describe('the bar button', () => {
  test('page host: an eligible viewer gets the button in the bar, asked of the server by slug', async () => {
    renderChrome();
    // In the bar itself — no menu has been opened.
    await expect
      .element(page.getByRole('button', { name: 'Send feedback to developer' }))
      .toBeInTheDocument();
    await expect.element(feedbackButton()).toBeVisible();
    expect(page.getByTestId('app-block-menu-dropdown').elements()).toHaveLength(0);
    expect(mocks.eligibilityInputs).toEqual([{ target: { slug: SLUG } }]);
  });

  test('model slot: the button is offered there too, asked of the server by AppBlock id', async () => {
    renderChrome(SLOT_PROPS);
    await expect.element(feedbackButton()).toBeVisible();
    expect(mocks.eligibilityInputs).toEqual([{ target: { appBlockId: APP_BLOCK_ID } }]);
  });

  test('desktop: a labelled "Feedback" button right before the ⋮ trigger, the bar height', async () => {
    renderChrome();
    await expect.element(feedbackButton()).toBeVisible();
    const button = feedbackButton().element() as HTMLElement;
    const trigger = menuTrigger().element() as HTMLElement;
    expect(button.closest('[data-testid="app-block-chrome"]')).not.toBeNull();
    // Same trailing cluster, button first.
    expect(button.parentElement).toBe(trigger.parentElement);
    expect(button.nextElementSibling).toBe(trigger);
    expectStyledOneLineBar();
    const b = rectOf(button);
    const t = rectOf(trigger);
    // Right before ⋮ (the cluster's 4px gap), not floated elsewhere in the row.
    expect(b.right).toBeLessThanOrEqual(t.left);
    expect(t.left - b.right).toBeLessThanOrEqual(8);
    expectLabelled();
    expect([t.width, t.height]).toEqual([RESTING_ICON_PX, RESTING_ICON_PX]);
    expect(b.top).toBe(t.top);
    await expect.element(page.getByText('Feedback', { exact: true })).toBeVisible();
    // Pinned to the right edge with ⋮, not floated into the middle of the row.
    expect(rectOf(chromeBar()).right - t.right).toBeLessThan(16);
  });

  test('a full-width bar (~1840px) shows the label at the far right', async () => {
    await page.viewport(1840, 900);
    renderChrome();
    await expect.element(feedbackButton()).toBeVisible();
    expectStyledOneLineBar();
    expect(Math.round(rectOf(chromeBar()).width)).toBe(1840);
    expect(chromeBar().getAttribute('data-chrome-compact')).toBe('false');
    expectLabelled();
  });

  test('hover shows a tooltip with the same text', async () => {
    renderChrome();
    await expect.element(feedbackButton()).toBeVisible();
    expect(page.getByRole('tooltip').elements()).toHaveLength(0);
    await feedbackButton().hover();
    await expect.element(page.getByRole('tooltip')).toHaveTextContent('Send feedback to developer');
  });

  test('keyboard focus also shows the tooltip', async () => {
    renderChrome();
    await expect.element(feedbackButton()).toBeVisible();
    expect(page.getByRole('tooltip').elements()).toHaveLength(0);
    // Park the pointer off the button first: the previous test hovered this exact spot, and a
    // pointer left there opens the tooltip by hover, which would pass this test for the wrong
    // reason (measured: it did, with `focus: false`).
    await menuTrigger().hover();
    await new Promise((r) => setTimeout(r, 400)); // past the 300ms openDelay
    expect(page.getByRole('tooltip').elements()).toHaveLength(0);
    (feedbackButton().element() as HTMLElement).focus();
    await expect.element(page.getByRole('tooltip')).toHaveTextContent('Send feedback to developer');
  });

  test('absent while the eligibility answer is still in flight', async () => {
    let release: () => void = () => undefined;
    mocks.eligibilityGate = new Promise<void>((r) => {
      release = r;
    });
    renderChrome();
    await vi.waitFor(() => expect(mocks.eligibilityInputs).toHaveLength(1));
    await expect.element(menuTrigger()).toBeInTheDocument();
    expect(feedbackButton().elements()).toHaveLength(0);
    // CONTROL: the same render shows it once the answer lands.
    release();
    await expect.element(feedbackButton()).toBeVisible();
  });

  test('absent when the eligibility query fails (e.g. the procedure refuses the viewer)', async () => {
    mocks.eligibilityError = true;
    renderChrome(PAGE_PROPS, { slug: SLUG });
    await expect.element(page.getByTestId('eligibility-probe-errored')).toBeInTheDocument();
    expect(mocks.eligibilityInputs).toHaveLength(1);
    expect(feedbackButton().elements()).toHaveLength(0);
  });

  test('hidden when the server says not eligible (muted, flag off, …)', async () => {
    mocks.eligibility = { eligible: false };
    renderChrome(PAGE_PROPS, { slug: SLUG });
    await expect.element(page.getByTestId('eligibility-probe-resolved')).toBeInTheDocument();
    await expect.element(menuTrigger()).toBeInTheDocument();
    expect(mocks.eligibilityInputs).toHaveLength(1);
    expect(feedbackButton().elements()).toHaveLength(0);
  });

  test('CONTROL — the same harness shows it when eligible', async () => {
    renderChrome(PAGE_PROPS, { slug: SLUG });
    await expect.element(page.getByTestId('eligibility-probe-resolved')).toBeInTheDocument();
    await expect.element(feedbackButton()).toBeInTheDocument();
  });

  test('signed out: no button and no eligibility request', async () => {
    mocks.user = null;
    renderChrome();
    await expect.element(menuTrigger()).toBeInTheDocument();
    expect(feedbackButton().elements()).toHaveLength(0);
    expect(mocks.eligibilityInputs).toHaveLength(0);
  });

  // 🔴 The dev tunnel runs unpublished code; a report there would be stamped with the published
  // version. Same page props as the CONTROL above, only the host surface differs.
  for (const hostSurface of ['dev-tunnel', 'review-preview', undefined]) {
    test(`host surface ${String(hostSurface)}: no button and no eligibility request`, async () => {
      renderChrome({ ...PAGE_PROPS, hostSurface });
      await expect.element(menuTrigger()).toBeInTheDocument();
      expect(feedbackButton().elements()).toHaveLength(0);
      expect(mocks.eligibilityInputs).toHaveLength(0);
    });
  }

  test('no store access: no button and no eligibility request', async () => {
    mocks.features = {};
    renderChrome();
    await expect.element(menuTrigger()).toBeInTheDocument();
    expect(feedbackButton().elements()).toHaveLength(0);
    expect(mocks.eligibilityInputs).toHaveLength(0);
  });

  test('the ⋮ menu no longer carries a feedback item (one entry point)', async () => {
    renderChrome();
    await expect.element(feedbackButton()).toBeInTheDocument();
    await openOverflow();
    await expect.element(page.getByRole('menuitem', { name: 'Manage apps' })).toBeInTheDocument();
    expect(feedbackMenuItem().elements()).toHaveLength(0);
    expect(
      page.getByRole('menuitem', { name: 'Send feedback to developer' }).elements()
    ).toHaveLength(0);
    // Still one request: the button's, not a second observer inside the menu.
    expect(mocks.eligibilityInputs).toHaveLength(1);
  });
});

describe('opening the modal', () => {
  test('clicking the button opens the private-feedback modal titled for the app — no notice, no "sent with" line', async () => {
    await openFeedbackModal();
    await expect
      .element(page.getByRole('dialog'))
      .toHaveAccessibleName("Send private feedback to Pixel Forge's developer");
    await expect.element(messageBox()).toBeVisible();
    // The removed copy, under any testid or wording it used to have.
    const text = (page.getByRole('dialog').element() as HTMLElement).textContent ?? '';
    expect(text).not.toContain('Private.');
    expect(text).not.toContain('can read this');
    expect(text).not.toContain('Sent with');
    expect(text).not.toContain('Nothing else is collected');
    expect(page.getByTestId('app-feedback-private-notice').elements()).toHaveLength(0);
    expect(page.getByTestId('app-feedback-sent-with').elements()).toHaveLength(0);
    // CONTROL: the same read does see the dialog's own copy.
    expect(text).toContain('Your feedback');
    // The ⋮ menu was never involved.
    expect(menuTrigger().element().getAttribute('aria-expanded')).toBe('false');
  });

  test('desktop (1280×900): bottom-anchored 10dvh above the viewport bottom, centred horizontally, not full-screen', async () => {
    await page.viewport(1280, 900);
    await openFeedbackModal();
    const r = await settledDialogRect();
    expect(dialogContent()?.classList.contains('mantine-Modal-content')).toBe(true);
    expect(dialogContent()?.getAttribute('data-full-screen')).toBeNull();
    // 10dvh of 900 = 90: the dialog's bottom edge sits 90px above the viewport's.
    expect(Math.abs(window.innerHeight - r.bottom - 90)).toBeLessThanOrEqual(1);
    // …which is NOT where a centred dialog would be (control for the assertion above).
    expect(Math.abs((r.top + r.bottom) / 2 - window.innerHeight / 2)).toBeGreaterThan(50);
    // Width and horizontal centring unchanged: Mantine `size="md"` is 440px.
    expect(Math.round(r.width)).toBe(440);
    expect(Math.abs(r.left - (window.innerWidth - r.right))).toBeLessThanOrEqual(1);
  });

  test('desktop at a second height (1280×700): still 10dvh (70px) from the bottom', async () => {
    await page.viewport(1280, 700);
    await openFeedbackModal();
    const r = await settledDialogRect();
    expect(Math.abs(window.innerHeight - r.bottom - 70)).toBeLessThanOrEqual(1);
  });

  test('the textarea has focus on open (not the close button)', async () => {
    await openFeedbackModal();
    await vi.waitFor(() => expect(document.activeElement).toBe(messageBox().element()));
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

describe('the character counter', () => {
  test('absent at 1,500 characters', async () => {
    await openFeedbackModal();
    await userEvent.fill(messageBox().element() as HTMLElement, 'a'.repeat(1500));
    await vi.waitFor(() =>
      expect((messageBox().element() as HTMLTextAreaElement).value).toHaveLength(1500)
    );
    expect(counter().elements()).toHaveLength(0);
  });

  test('shown past 1,500 as "1,850 / 2,000"', async () => {
    await openFeedbackModal();
    await userEvent.fill(messageBox().element() as HTMLElement, 'a'.repeat(1850));
    await expect.element(counter()).toHaveTextContent('1,850 / 2,000');
  });
});

describe('keyboard submit', () => {
  test('Ctrl+Enter sends', async () => {
    await openFeedbackModal();
    await userEvent.fill(messageBox().element() as HTMLElement, 'quick note');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await expectClosedWithToast();
    expect(mocks.createInputs).toStrictEqual([
      { target: { slug: SLUG }, message: 'quick note', context: { surface: 'page' } },
    ]);
  });

  test('⌘+Enter sends', async () => {
    await openFeedbackModal();
    await userEvent.fill(messageBox().element() as HTMLElement, 'mac note');
    await userEvent.keyboard('{Meta>}{Enter}{/Meta}');
    await expectClosedWithToast();
    expect(mocks.createInputs).toHaveLength(1);
  });

  test('plain Enter is a newline, not a send', async () => {
    await openFeedbackModal();
    await userEvent.fill(messageBox().element() as HTMLElement, 'line one');
    await userEvent.keyboard('{Enter}');
    await vi.waitFor(() =>
      expect((messageBox().element() as HTMLTextAreaElement).value).toBe('line one\n')
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(mocks.createInputs).toHaveLength(0);
    await expect.element(modal()).toBeInTheDocument();
    // CONTROL: the same box, same harness, sends on Ctrl+Enter.
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await vi.waitFor(() => expect(mocks.createInputs).toHaveLength(1));
  });

  test('a Ctrl+Enter that commits an IME composition is not a send', async () => {
    await openFeedbackModal();
    await userEvent.fill(messageBox().element() as HTMLElement, '日本語');
    const box = messageBox().element() as HTMLTextAreaElement;
    const keydown = (init: KeyboardEventInit) =>
      box.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, ...init })
      );
    keydown({ isComposing: true });
    // Safari's shape: composition already ended, keyCode 229 on the committing keydown.
    keydown({ isComposing: false, keyCode: 229 });
    await new Promise((r) => setTimeout(r, 200));
    expect(mocks.createInputs).toHaveLength(0);
    // CONTROL: the same synthetic event without the composition sends.
    keydown({ isComposing: false });
    await vi.waitFor(() => expect(mocks.createInputs).toHaveLength(1));
  });

  test('two Ctrl+Enter keydowns before the pending render send once', async () => {
    await openFeedbackModal();
    await userEvent.fill(messageBox().element() as HTMLElement, 'once only');
    const box = messageBox().element() as HTMLTextAreaElement;
    const keydown = () =>
      box.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })
      );
    // Same tick: React has not re-rendered between them, so neither the disabled textarea nor
    // `isPending` stands in the second one's way.
    keydown();
    keydown();
    await expectClosedWithToast();
    expect(mocks.createInputs).toHaveLength(1);
  });

  test('Ctrl+Enter on an empty message sends nothing', async () => {
    await openFeedbackModal();
    await vi.waitFor(() => expect(document.activeElement).toBe(messageBox().element()));
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await new Promise((r) => setTimeout(r, 200));
    expect(mocks.createInputs).toHaveLength(0);
    await expect.element(modal()).toBeInTheDocument();
  });
});

describe('submitting', () => {
  test('page host: sends exactly {target: slug, message, context: {surface: page}}, closes and toasts', async () => {
    await openFeedbackModal();
    await typeAndSend('  the export button 404s  ');
    await expectClosedWithToast();
    expect(mocks.createInputs).toStrictEqual([
      { target: { slug: SLUG }, message: 'the export button 404s', context: { surface: 'page' } },
    ]);
  });

  test('model slot: sends exactly {target: appBlockId, message, context: {surface: slot, modelId}}', async () => {
    await openFeedbackModal(SLOT_PROPS);
    await typeAndSend('love it');
    await expectClosedWithToast();
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
      'muted account',
      'FORBIDDEN',
      'Your account cannot send feedback right now',
      'Your account cannot send feedback right now',
    ],
  ];

  for (const [name, code, serverMessage, shown] of errorCases) {
    test(`${name} (${code}): readable error inline, modal stays open, text kept, no toast`, async () => {
      mocks.createResult = { kind: 'error', code, message: serverMessage };
      await openFeedbackModal();
      await typeAndSend('my feedback');
      await expect.element(page.getByTestId('app-feedback-error')).toHaveTextContent(shown);
      await expect.element(modal()).toBeInTheDocument();
      expect((messageBox().element() as HTMLTextAreaElement).value).toBe('my feedback');
      expect(mocks.successes).toHaveLength(0);
    });
  }
});

describe('after an inline error', () => {
  test('the kept text can be sent again', async () => {
    mocks.createResult = { kind: 'error', code: 'TOO_MANY_REQUESTS', message: 'Slow down' };
    await openFeedbackModal();
    await typeAndSend('second time lucky');
    await expect.element(page.getByTestId('app-feedback-error')).toHaveTextContent('Slow down');
    mocks.createResult = { kind: 'ok' };
    await sendButton().click();
    await expectClosedWithToast();
    expect(mocks.createInputs).toHaveLength(2);
  });
});

describe('alongside the review entry on the page host', () => {
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

  test('page host: "Rate this app" stays in the ⋮ menu and feedback is the bar button', async () => {
    mocks.detail = reviewableDetail;
    renderChrome();
    await expect.element(feedbackButton()).toBeVisible();
    await openOverflow();
    await expect
      .element(page.getByTestId('app-block-review-menu-item'))
      .toHaveTextContent('Rate this app');
    expect(feedbackMenuItem().elements()).toHaveLength(0);
  });
});

describe('a reused host (app A → app B without remount)', () => {
  const chrome = (slug: string) => (
    <AppBlockChrome blockInstanceId="inst-fb" appName={APP_NAME} {...PAGE_PROPS} slug={slug} />
  );

  test('the open modal still sends to the app it was opened for', async () => {
    const view = await render(chrome('app-a'), { wrapper: ProdishProviders });
    await expect.element(feedbackButton()).toBeInTheDocument();
    await feedbackButton().click();
    await expect.element(modal()).toBeInTheDocument();
    // Same element type at the same position, so React updates props rather than remounting —
    // the modal staying open is what shows it.
    await view.rerender(chrome('app-b'));
    await expect.element(modal()).toBeInTheDocument();
    await typeAndSend('about app A');
    await expectClosedWithToast();
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

    expect(mocks.successes).toHaveLength(0);

    release();
    await expectClosedWithToast();
    expect(mocks.createInputs).toHaveLength(1);
  });
});

describe('the phone bottom sheet (375×720)', () => {
  beforeEach(async () => {
    await page.viewport(375, 720);
  });

  test('a Drawer pinned to the bottom edge, full width, sized to its content — not a full-screen modal', async () => {
    await openFeedbackModal();
    const r = await settledDialogRect();
    expect(dialogContent()?.classList.contains('mantine-Drawer-content')).toBe(true);
    expect(document.querySelector('.mantine-Modal-content')).toBeNull();
    expect(Math.abs(window.innerHeight - r.bottom)).toBeLessThanOrEqual(1);
    expect(Math.round(r.left)).toBe(0);
    expect(Math.round(r.width)).toBe(375);
    // Sized to content: well short of the screen, so the app stays visible above it.
    expect(r.height).toBeLessThan(window.innerHeight * 0.75);
    // Minimal chrome: the header is not held at Mantine's 60px minimum.
    const header = document.querySelector<HTMLElement>('.mantine-Drawer-header');
    expect(header).not.toBeNull();
    expect(header!.getBoundingClientRect().height).toBeLessThan(60);
    // Everything the user needs is on screen.
    expect(rectOf(sendButton().element()).bottom).toBeLessThanOrEqual(window.innerHeight);
  });

  test('a lighter scrim (alpha 0.25) over an opaque sheet', async () => {
    await openFeedbackModal();
    await settledDialogRect();
    const overlay = document.querySelector<HTMLElement>('.mantine-Drawer-overlay');
    expect(overlay).not.toBeNull();
    const overlayStyle = getComputedStyle(overlay as HTMLElement);
    // The colour's alpha carries the lightness; the element itself is not faded on top of it.
    expect(alphaOf(overlayStyle.backgroundColor)).toBeCloseTo(0.25, 2);
    expect(Number(overlayStyle.opacity)).toBe(1);
    const sheet = getComputedStyle(dialogContent() as HTMLElement);
    expect(alphaOf(sheet.backgroundColor)).toBe(1);
    expect(Number(sheet.opacity)).toBe(1);
  });

  test('while a send is pending, Esc and a scrim tap cannot dismiss the sheet', async () => {
    let release: () => void = () => undefined;
    mocks.createGate = new Promise<void>((r) => {
      release = r;
    });
    await openFeedbackModal();
    await settledDialogRect();
    await userEvent.fill(messageBox().element() as HTMLElement, 'from my phone');
    await sendButton().click();
    await vi.waitFor(() => expect(mocks.createInputs).toHaveLength(1));
    // Wait for the PENDING render, not just the request: the guard reads `isPending`.
    await expect.element(messageBox()).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    // A real tap above the sheet (hit-tested, so it must land on the scrim), not a DOM click.
    await userEvent.click(page.elementLocator(scrim()), { position: { x: 10, y: 10 } });
    await new Promise((r) => setTimeout(r, 300));
    await expect.element(modal()).toBeInTheDocument();
    expect(dialogContent()).not.toBeNull();
    expect(mocks.successes).toHaveLength(0);
    release();
    await expectClosedWithToast();
  });

  test('CONTROL — with nothing pending, a scrim tap does dismiss the sheet', async () => {
    await openFeedbackModal();
    await settledDialogRect();
    await userEvent.click(page.elementLocator(scrim()), { position: { x: 10, y: 10 } });
    await expect.element(modal()).not.toBeInTheDocument();
  });

  test('the sheet sits above routed dialogs and the generation panel (z-index tier 400)', async () => {
    await openFeedbackModal();
    const inner = document.querySelector<HTMLElement>('.mantine-Drawer-inner');
    expect(inner).not.toBeNull();
    // `mobileMenuSheetZIndex`, via `MobileMenuDrawer`; Mantine's own default would be 200.
    expect(getComputedStyle(inner as HTMLElement).zIndex).toBe('400');
  });

  test('the textarea has focus on open in the sheet too', async () => {
    await openFeedbackModal();
    await vi.waitFor(() => expect(document.activeElement).toBe(messageBox().element()));
  });

  test('success closes the sheet and toasts', async () => {
    await openFeedbackModal();
    await typeAndSend('from my phone');
    await expectClosedWithToast();
  });

  test('an error stays inline in the sheet', async () => {
    mocks.createResult = { kind: 'error', code: 'FORBIDDEN', message: 'Nope' };
    await openFeedbackModal();
    await typeAndSend('from my phone');
    await expect.element(page.getByTestId('app-feedback-error')).toHaveTextContent('Nope');
    await expect.element(modal()).toBeInTheDocument();
    expect(mocks.successes).toHaveLength(0);
  });

  describe('with the on-screen keyboard up', () => {
    test('the sheet rides above a 300px keyboard and drops back when it closes', async () => {
      const fake = installFakeViewport();
      await openFeedbackModal();
      forceTextareaHeight(TEXTAREA_4_ROWS_PX);
      // CONTROL: keyboard down, the sheet is on the bottom edge.
      expect(Math.abs(window.innerHeight - (await settledDialogRect()).bottom)).toBeLessThanOrEqual(
        1
      );
      const visible = showKeyboard(fake, 300);
      expect(visible).toBe(420);
      await vi.waitFor(() =>
        expect(Math.abs(dialogContent()!.getBoundingClientRect().bottom - 420)).toBeLessThanOrEqual(
          1
        )
      );
      // At the 4-row minimum everything fits above the keyboard with no scrolling.
      await expectSendReachable(420, { mustScroll: false });
      expect(rectOf(messageBox().element()).top).toBeGreaterThanOrEqual(0);
      showKeyboard(fake, 0);
      await vi.waitFor(() =>
        expect(Math.abs(dialogContent()!.getBoundingClientRect().bottom - 720)).toBeLessThanOrEqual(
          1
        )
      );
    });

    test('a 10-row message over a 360px keyboard: the sheet scrolls and Send can be reached', async () => {
      const fake = installFakeViewport();
      await openFeedbackModal();
      await settledDialogRect();
      forceTextareaHeight(TEXTAREA_10_ROWS_PX);
      await expectSendReachable(showKeyboard(fake, 360), { mustScroll: true });
    });

    test('iOS pans the visual viewport: only the part below it counts as keyboard', async () => {
      const fake = installFakeViewport();
      await openFeedbackModal();
      await settledDialogRect();
      fake.height = 420;
      fake.offsetTop = 100;
      fake.dispatchEvent(new Event('scroll'));
      await vi.waitFor(() =>
        expect(Math.abs(dialogContent()!.getBoundingClientRect().bottom - 520)).toBeLessThanOrEqual(
          1
        )
      );
    });
  });
});

describe('the wide dialog on a touch device (1024×768) with the on-screen keyboard up', () => {
  // A tablet, or a phone held sideways, is wider than the `sm` rule, so it gets the Modal — which
  // is bottom-anchored and would sit under the keyboard.
  beforeEach(async () => {
    await page.viewport(1024, 768);
  });

  test('the dialog rides above a 300px keyboard and returns to its 10dvh offset after', async () => {
    const fake = installFakeViewport();
    await openFeedbackModal();
    forceTextareaHeight(TEXTAREA_4_ROWS_PX);
    expect(dialogContent()?.classList.contains('mantine-Modal-content')).toBe(true);
    // CONTROL: keyboard down, 10dvh (76.8px) above the bottom — i.e. under where a keyboard goes.
    const resting = await settledDialogRect();
    expect(Math.abs(window.innerHeight - resting.bottom - 76.8)).toBeLessThanOrEqual(1);
    expect(resting.bottom).toBeGreaterThan(468);
    const visible = showKeyboard(fake, 300);
    expect(visible).toBe(468);
    // An 8px gap above the keyboard.
    await vi.waitFor(() =>
      expect(Math.abs(dialogContent()!.getBoundingClientRect().bottom - 460)).toBeLessThanOrEqual(1)
    );
    await expectSendReachable(468, { mustScroll: false });
    showKeyboard(fake, 0);
    await vi.waitFor(() =>
      expect(
        Math.abs(window.innerHeight - dialogContent()!.getBoundingClientRect().bottom - 76.8)
      ).toBeLessThanOrEqual(1)
    );
  });

  test('a 10-row message over a 468px keyboard (300px visible): the dialog scrolls and Send can be reached', async () => {
    const fake = installFakeViewport();
    await openFeedbackModal();
    await settledDialogRect();
    forceTextareaHeight(TEXTAREA_10_ROWS_PX);
    await expectSendReachable(showKeyboard(fake, 468), { mustScroll: true });
  });
});

describe('narrow bars', () => {
  test('at 375px the compact shell has the button beside ⋮ (not in the sheet)', async () => {
    await page.viewport(375, 720);
    renderChrome();
    const root = page.getByTestId('app-block-chrome');
    await expect.element(root).toBeInTheDocument();
    await vi.waitFor(() =>
      expect((root.element() as HTMLElement).getAttribute('data-chrome-compact')).toBe('true')
    );
    await expect.element(feedbackButton()).toBeVisible();
    expectStyledOneLineBar();
    // Icon-only here, the same tap target as its neighbours, the back chevron and ⋮.
    expectIconOnly();
    for (const id of ['app-block-feedback-button', 'app-block-menu-trigger', 'app-block-back']) {
      const r = rectOf(page.getByTestId(id).element());
      expect([r.width, r.height], id).toEqual([RESTING_ICON_PX, RESTING_ICON_PX]);
    }
    expect((feedbackButton().element() as HTMLElement).nextElementSibling).toBe(
      menuTrigger().element()
    );
    const b = rectOf(feedbackButton().element());
    const t = rectOf(menuTrigger().element());
    expect(t.left - b.right).toBeLessThanOrEqual(8);
    // The sheet no longer carries the item, under any testid.
    await openOverflow();
    expect(feedbackMenuItem().elements()).toHaveLength(0);
    const sheet = page.getByTestId('app-block-menu-dropdown').element();
    expect(sheet.textContent).not.toContain('Send feedback to developer');
    await userEvent.keyboard('{Escape}');
    await expect.element(page.getByTestId('app-block-menu-dropdown')).not.toBeInTheDocument();
  });

  test('a 320px model sidebar keeps the button in the one-line bar', async () => {
    render(
      <div style={{ width: 320 }}>
        <AppBlockChrome blockInstanceId="inst-fb" appName={APP_NAME} {...SLOT_PROPS} />
      </div>,
      { wrapper: ProdishProviders }
    );
    await expect.element(feedbackButton()).toBeVisible();
    await waitForIconOnly();
    expectStyledOneLineBar();
    const bar = rectOf(chromeBar());
    expect(Math.round(bar.width)).toBe(320);
    const b = rectOf(feedbackButton().element());
    const t = rectOf(menuTrigger().element());
    expect(b.top).toBe(t.top);
    // Right before ⋮ (the cluster's 4px gap), not floated elsewhere in the row.
    expect(b.right).toBeLessThanOrEqual(t.left);
    expect(t.left - b.right).toBeLessThanOrEqual(8);
    expect(t.right).toBeLessThanOrEqual(bar.right);
    // No mobile shell on the model slot (`data-chrome-compact` is the SHELL decision, page-only),
    // but the bar is still narrow, so the button is icon-only.
    expect(chromeBar().getAttribute('data-chrome-compact')).toBe('false');
    expect(chromeBar().getAttribute('data-chrome-tier')).toBe('base');
    expectIconOnly();
  });

  test('the label switches at the `sm` bar width: 767px icon-only, resized to 768px labelled', async () => {
    // One mounted tree, resized across the boundary. Starting at 767 means the labelled state at
    // 768 is OBSERVED as a flip from a measured icon-only bar — not the unmeasured first render,
    // which is labelled too and would pass a 768-only check without any measurement.
    await page.viewport(1280, 720);
    const at = (width: number) => (
      <div style={{ width }}>
        <AppBlockChrome blockInstanceId="inst-fb" appName={APP_NAME} {...SLOT_PROPS} />
      </div>
    );
    const view = await render(at(767), { wrapper: ProdishProviders });
    await expect.element(feedbackButton()).toBeVisible();
    await waitForIconOnly();
    expect(Math.round(rectOf(chromeBar()).width)).toBe(767);
    expectIconOnly();
    await view.rerender(at(768));
    await vi.waitFor(() =>
      expect(feedbackButton().element().getAttribute('data-labelled')).toBe('true')
    );
    expect(Math.round(rectOf(chromeBar()).width)).toBe(768);
    expectLabelled();
  });

  test('the icon-only form keeps the tooltip', async () => {
    render(
      <div style={{ width: 320 }}>
        <AppBlockChrome blockInstanceId="inst-fb" appName={APP_NAME} {...SLOT_PROPS} />
      </div>,
      { wrapper: ProdishProviders }
    );
    await expect.element(feedbackButton()).toBeVisible();
    await waitForIconOnly();
    expect(page.getByRole('tooltip').elements()).toHaveLength(0);
    await feedbackButton().hover();
    await expect.element(page.getByRole('tooltip')).toHaveTextContent('Send feedback to developer');
  });

  const LONG_NAME =
    'An Extraordinarily Long Application Name That Would Happily Fill The Whole Bar';

  test.each([
    ['320px model sidebar', SLOT_PROPS, 320, false],
    ['375px compact page shell', PAGE_PROPS, 375, false],
    ['1280px desktop page host', PAGE_PROPS, 1280, true],
  ] as const)(
    // INVARIANT GUARD, not regression coverage: Mantine's ActionIcon `min-width` and the Button
    // label's `nowrap` already hold the size (removing every `flexShrink: 0` here stays green). It
    // pins the outcome, whatever holds it.
    'INVARIANT GUARD — a long app name cannot squeeze the button or ⋮ (%s)',
    async (_label, props, width, labelled) => {
      await page.viewport(width, 720);
      render(
        <div style={{ width }}>
          <AppBlockChrome blockInstanceId="inst-fb" appName={LONG_NAME} {...props} />
        </div>,
        { wrapper: ProdishProviders }
      );
      await expect.element(feedbackButton()).toBeVisible();
      if (!labelled) await waitForIconOnly();
      expectStyledOneLineBar();
      const bar = rectOf(chromeBar());
      if (labelled) expectLabelled();
      else expectIconOnly();
      const t = rectOf(menuTrigger().element());
      expect([t.width, t.height]).toEqual([RESTING_ICON_PX, RESTING_ICON_PX]);
      expect(rectOf(feedbackButton().element()).right).toBeLessThanOrEqual(t.left);
      expect(t.right).toBeLessThanOrEqual(bar.right);
    }
  );
});
