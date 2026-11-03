import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type * as Trpc from '~/utils/trpc';
import type * as Constants from '~/shared/constants/showcase-hat.constants';

import '~/styles/globals.css';

const h = vi.hoisted(() => ({
  state: { pick: null, showing: 11, off: false } as {
    pick: number | null;
    showing: number | null;
    off: boolean;
  } | null,
  hats: [{ cosmeticId: 11, name: 'Party Cap' }] as { cosmeticId: number; name: string }[],
  live: true,
  user: { id: 1 } as { id: number } | null,
  set: vi.fn(),
}));
vi.mock('~/utils/trpc', async (importOriginal) => {
  const { makeTrpcProxy } = await import('../../../../test/trpcProxyStub');
  return {
    ...(await importOriginal<typeof Trpc>()),
    trpc: makeTrpcProxy({
      'event.getMyShowcaseHat': { useQuery: () => ({ data: h.state }) },
      'event.getMyHats': { useQuery: () => ({ data: h.hats }) },
      'event.setShowcaseHat': { useMutation: () => ({ isPending: false, mutate: h.set }) },
    }),
  };
});
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => h.user }));
vi.mock('~/shared/constants/showcase-hat.constants', async (importOriginal) => ({
  ...(await importOriginal<typeof Constants>()),
  isShowcaseLive: () => h.live,
}));

import { DialogProvider } from '~/components/Dialog/DialogProvider';
import { ShowcaseHatButton } from './ShowcaseHatPicker';
import { ShowcaseHatPickerToggle, ShowcaseHatSetting } from './ShowcaseHatToggle';
import { renderWithProviders } from '../../../../test/component-setup';
import { cleanup } from 'vitest-browser-react';

const toggle = () =>
  document.body.querySelector<HTMLInputElement>('[data-testid="showcase-hat-toggle"]');

beforeEach(() => {
  h.state = { pick: null, showing: 11, off: false };
  h.hats = [{ cosmeticId: 11, name: 'Party Cap' }];
  h.live = true;
  h.user = { id: 1 };
  h.set.mockReset();
});
afterEach(() => cleanup());

describe.each([
  ['picker', () => <ShowcaseHatPickerToggle />],
  ['account settings', () => <ShowcaseHatSetting />],
])('showcase hat toggle in the %s', (_name, view) => {
  test('on by default; flipping it off writes { off: true }', async () => {
    renderWithProviders(view());
    await vi.waitFor(() => expect(toggle()).not.toBeNull());
    expect(toggle()!.checked).toBe(true);
    toggle()!.click();
    expect(h.set).toHaveBeenCalledWith({ event: 'birthday2026', off: true });
  });

  test('off reads as unchecked; flipping it back on writes { off: false }', async () => {
    h.state = { pick: null, showing: null, off: true };
    renderWithProviders(view());
    await vi.waitFor(() => expect(toggle()).not.toBeNull());
    expect(toggle()!.checked).toBe(false);
    toggle()!.click();
    expect(h.set).toHaveBeenCalledWith({ event: 'birthday2026', off: false });
  });

  test('stays disabled until the setting has loaded', async () => {
    h.state = null;
    renderWithProviders(view());
    await vi.waitFor(() => expect(toggle()).not.toBeNull());
    expect(toggle()!.disabled).toBe(true);
  });
});

describe('account settings gate', () => {
  test.each([
    ['the event is over', () => void (h.live = false)],
    ['the user owns no event hat', () => void (h.hats = [])],
    ['signed out', () => void (h.user = null)],
  ])('shows nothing when %s', async (_name, setup) => {
    setup();
    renderWithProviders(<ShowcaseHatSetting />);
    await new Promise((r) => setTimeout(r, 300));
    expect(toggle()).toBeNull();
  });
});

describe('picker Automatic tile', () => {
  const openPicker = async () => {
    renderWithProviders(
      <>
        <DialogProvider />
        <ShowcaseHatButton event="birthday2026" />
      </>
    );
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="showcase-hat-button"]')).not.toBeNull()
    );
    (document.querySelector('[data-testid="showcase-hat-button"]') as HTMLElement).click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="showcase-hat-auto"]')).not.toBeNull()
    );
    return document.querySelector('[data-testid="showcase-hat-auto"]') as HTMLElement;
  };

  test('says so when the default shows no hat yet', async () => {
    h.state = { pick: null, showing: null, off: false };
    expect((await openPicker()).textContent).toContain('No hat until you place one');
  });

  test('says "Your top hat" when the default has one', async () => {
    expect((await openPicker()).textContent).toContain('Your top hat');
  });

  test('is not marked selected while the hat is off', async () => {
    h.state = { pick: null, showing: null, off: true };
    expect((await openPicker()).getAttribute('aria-pressed')).toBe('false');
  });
});
