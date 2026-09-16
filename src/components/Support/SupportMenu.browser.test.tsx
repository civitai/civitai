import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type * as TrpcModule from '~/utils/trpc';
import { useAssistantPanelStore } from '~/store/assistant-panel.store';
import { renderWithProviders } from '../../../test/component-setup';

/**
 * SupportMenu — the footer support button after it stopped opening a modal.
 *
 * 🔴 WHAT IS FAKED. `dialogStore` is replaced so "did this open the feedback panel"
 * is observable without mounting a Drawer; `trpc` is replaced because the scaffold
 * wires no transport, and its `getArea` stub RECORDS the options it was handed —
 * that is what makes "we never asked the server for a logged-out viewer" a real
 * assertion rather than an absence nobody checked.
 *
 * `useCurrentUser` is replaced per-test through a mutable holder rather than a
 * fresh `vi.mock`, because the signed-in and signed-out cases are the two halves of
 * the same decision and belong in one file.
 */
const { mocks } = vi.hoisted(() => ({
  mocks: {
    trigger: vi.fn(),
    getAreaOptions: vi.fn(),
    currentUser: { value: null as { id: number } | null },
    areaEnabled: { value: true },
    assistant: { value: null as { personality: string; uuid: string } | null },
  },
}));

vi.mock('~/components/Assistant/useAssistantAvailable', () => ({
  useAssistantAvailable: () => mocks.assistant.value,
}));

vi.mock('~/components/Dialog/dialogStore', () => ({
  dialogStore: { trigger: mocks.trigger, toggle: vi.fn(), closeById: vi.fn() },
}));

vi.mock('~/hooks/useCurrentUser', () => ({
  useCurrentUser: () => mocks.currentUser.value,
}));

vi.mock('~/utils/trpc', async (importOriginal) => {
  const actual = await importOriginal<typeof TrpcModule>();
  return {
    ...actual,
    trpc: {
      feedback: {
        getArea: {
          useQuery: (_input: unknown, options?: { enabled?: boolean }) => {
            mocks.getAreaOptions(options);
            // A disabled React Query resolves to `undefined`, not to a value — the
            // stub has to reproduce that or the logged-out case would read as
            // "enabled" and the fallback would never be exercised.
            if (!options?.enabled) return { data: undefined };
            return { data: { enabled: mocks.areaEnabled.value } };
          },
        },
      },
    },
  };
});

const { SupportMenu } = await import('~/components/Support/SupportMenu');

const openMenu = async () => {
  renderWithProviders(<SupportMenu />);
  await userEvent.click(page.getByRole('button', { name: '🛟 Support' }));
  await expect.element(page.getByRole('menuitem', { name: 'Education Hub' })).toBeInTheDocument();
};

const bugItem = () => page.getByRole('menuitem', { name: 'Report a bug' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentUser.value = { id: 1 };
  mocks.areaEnabled.value = true;
  mocks.assistant.value = { personality: 'civbot', uuid: 'uuid-1' };
  useAssistantPanelStore.setState({ opened: false });
});

describe('the destinations that used to live in the support modal', () => {
  // Labels AND hrefs: the four cards all pointed somewhere specific, and a menu that
  // lists the right words against the wrong destinations is the failure this replaces.
  // "Known Issues" is deliberately NOT in the FAQ label — the footer already renders a
  // "Known Issues" link to the onsite /issues two elements away, and the same words in
  // the same row pointing at two places is worse than a longer label.
  // Every one of these leaves the app, so every one opens in a new tab — a reporter
  // sent to the FAQ mid-report should still have the page they were reporting on.
  test.each([
    ['Education Hub', '/education'],
    ['FAQ', 'https://education.civitai.com/civitai-faq'],
    ['Discord Community', '/discord'],
    ['Support Portal', '/support-portal'],
  ])('%s opens %s in a new tab', async (name, href) => {
    await openMenu();
    const item = page.getByRole('menuitem', { name });
    await expect.element(item).toHaveAttribute('href', href);
    await expect.element(item).toHaveAttribute('target', '_blank');
  });
});

/**
 * The chat was the right-hand column of the support modal. The modal is gone, so the
 * menu is how it is reached from here — and it must be ABSENT rather than dead when
 * the chat is unavailable, because `AssistantButton` renders nothing in that case and
 * a menu item that opens an invisible panel is worse than no item.
 */
describe('the CivBot chat the support modal used to hold', () => {
  test('the item opens the chat panel', async () => {
    await openMenu();
    expect(useAssistantPanelStore.getState().opened).toBe(false);

    await userEvent.click(page.getByRole('menuitem', { name: 'Get help fast' }));
    expect(useAssistantPanelStore.getState().opened).toBe(true);
  });

  test('and is not offered at all when the chat is unavailable', async () => {
    mocks.assistant.value = null;
    await openMenu();

    expect(page.getByRole('menuitem', { name: 'Get help fast' }).elements()).toHaveLength(0);
  });
});

/**
 * 🔴 THE DECISION THIS FILE EXISTS TO PIN, addressed to whoever is about to
 * "simplify" it: "Report a bug" must NOT be a link to the ticket portal while the
 * in-product panel is available.
 *
 * `/bugs`, `/support-portal` and `/canny/bugs` are the same `next.config.mjs`
 * redirect to Freshdesk. Pointing this item there is a one-word change that looks
 * tidier than a conditional and silently restores exactly the behaviour this work
 * removed — every bug report going back to the support queue instead of arriving
 * with the reporter's Faro session attached.
 */
describe('🔴 "Report a bug" reaches the feedback panel, not the ticket portal', () => {
  test('clicking it opens the feedback drawer and navigates nowhere', async () => {
    await openMenu();
    const item = bugItem().element();
    expect(item.tagName, 'the bug item became an anchor — it must not navigate').not.toBe('A');
    expect(item.getAttribute('href')).toBeNull();

    await userEvent.click(bugItem());
    expect(mocks.trigger).toHaveBeenCalledTimes(1);
  });

  test('the fallback IS the ticket portal when the area is not collecting', async () => {
    mocks.areaEnabled.value = false;
    await openMenu();

    const item = bugItem().element();
    expect(item.tagName).toBe('A');
    expect(item.getAttribute('href')).toBe('/bugs');
    expect(mocks.trigger).not.toHaveBeenCalled();
  });

  test('a signed-out viewer gets the ticket portal, and the server is never asked', async () => {
    mocks.currentUser.value = null;
    await openMenu();

    expect(bugItem().element().getAttribute('href')).toBe('/bugs');
    // The positive control for that "never asked": the query IS rendered, it is
    // rendered DISABLED. An assertion that it was simply absent would also pass if
    // the component stopped rendering at all.
    expect(mocks.getAreaOptions).toHaveBeenCalled();
    for (const [options] of mocks.getAreaOptions.mock.calls) expect(options?.enabled).toBe(false);
  });
});
