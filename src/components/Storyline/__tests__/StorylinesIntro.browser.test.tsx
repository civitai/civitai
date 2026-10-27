import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { MantineProvider } from '@mantine/core';
import { renderToString } from 'react-dom/server';
import { renderWithProviders } from '../../../../test/component-setup';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { StartStorylineModal } from '~/components/Storyline/StartStorylineModal';
import {
  STORYLINES_INTRO_DISMISSED_KEY,
  StorylinesIntro,
} from '~/components/Storyline/StorylinesIntro';

/**
 * The welcome card on /storylines. Its "start one" button opens the start sheet when signed in, and
 * asks them to sign in otherwise (see StartStorylineButton.tsx).
 */

const mocks = vi.hoisted(() => ({ user: null as { username: string } | null }));
vi.mock('~/hooks/useCurrentUser', () => ({ useCurrentUser: () => mocks.user }));
vi.mock('~/components/LoginRedirect/LoginRedirect', () => ({
  LoginRedirect: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="login-redirect">{children}</div>
  ),
}));

beforeEach(() => {
  mocks.user = null;
  vi.restoreAllMocks();
  localStorage.removeItem(STORYLINES_INTRO_DISMISSED_KEY);
});

describe('StorylinesIntro', () => {
  test('a first visit sees the welcome and the three steps', async () => {
    renderWithProviders(<StorylinesIntro />);

    await expect
      .element(page.getByRole('heading', { name: 'Welcome to Storylines' }))
      .toBeVisible();
    for (const step of ['Read', 'Pick a path', 'Continue it'])
      await expect.element(page.getByText(step, { exact: true })).toBeVisible();
  });

  test('"Got it" hides it and remembers, so the next visit does not see it', async () => {
    const first = await renderWithProviders(<StorylinesIntro />);
    await page.getByRole('button', { name: 'Got it' }).click();

    await expect
      .element(page.getByRole('heading', { name: 'Welcome to Storylines' }))
      .not.toBeInTheDocument();
    expect(localStorage.getItem(STORYLINES_INTRO_DISMISSED_KEY)).toBe('1');

    await first.unmount();
    const read = vi.spyOn(Storage.prototype, 'getItem');
    renderWithProviders(<StorylinesIntro />);
    // Absence only counts once the stored value has been read.
    await expect
      .poll(() => read.mock.calls.some(([k]) => k === STORYLINES_INTRO_DISMISSED_KEY))
      .toBe(true);
    expect(document.body.textContent).not.toContain('Welcome to Storylines');
  });

  test('the server render shows nothing, so a returning visitor never sees it flash', () => {
    expect(
      renderToString(
        <MantineProvider>
          <StorylinesIntro />
        </MantineProvider>
      )
    ).not.toContain('Welcome to Storylines');
  });

  test('a stored value other than the dismissal shows it', async () => {
    localStorage.setItem(STORYLINES_INTRO_DISMISSED_KEY, '0');
    renderWithProviders(<StorylinesIntro />);
    await expect
      .element(page.getByRole('heading', { name: 'Welcome to Storylines' }))
      .toBeVisible();
  });

  test('with storage blocked it still shows, and dismissing still hides it', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    renderWithProviders(<StorylinesIntro />);
    await expect
      .element(page.getByRole('heading', { name: 'Welcome to Storylines' }))
      .toBeVisible();
    await page.getByRole('button', { name: 'Got it' }).click();
    await expect
      .element(page.getByRole('heading', { name: 'Welcome to Storylines' }))
      .not.toBeInTheDocument();
  });

  test('the close button dismisses it the same way as "Got it"', async () => {
    renderWithProviders(<StorylinesIntro />);
    await page.getByRole('button', { name: 'Dismiss the Storylines welcome' }).click();

    await expect
      .element(page.getByRole('heading', { name: 'Welcome to Storylines' }))
      .not.toBeInTheDocument();
    expect(localStorage.getItem(STORYLINES_INTRO_DISMISSED_KEY)).toBe('1');
  });

  test('signed out, "Start a storyline" asks them to sign in instead of opening the sheet', async () => {
    renderWithProviders(<StorylinesIntro />);

    await expect
      .element(
        page.getByTestId('login-redirect').getByRole('button', { name: 'Start a storyline' })
      )
      .toBeVisible();
    expect(page.getByRole('link', { name: 'Start a storyline' }).elements()).toHaveLength(0);
  });

  test('signed in, "Start a storyline" opens the start sheet', async () => {
    mocks.user = { username: 'civbot' };
    const trigger = vi.spyOn(dialogStore, 'trigger').mockImplementation(() => undefined as never);
    renderWithProviders(<StorylinesIntro />);

    await page.getByRole('button', { name: 'Start a storyline' }).click();
    expect(trigger).toHaveBeenCalledWith({
      component: StartStorylineModal,
      props: { post: undefined },
    });
    expect(page.getByTestId('login-redirect').elements()).toHaveLength(0);
    // A button that opens the sheet, not a link that leaves the page.
    expect(page.getByRole('link', { name: 'Start a storyline' }).elements()).toHaveLength(0);
  });

  test('the old hint about the post menu and the editor switch is gone', async () => {
    mocks.user = { username: 'civbot' };
    renderWithProviders(<StorylinesIntro />);

    await expect.element(page.getByRole('button', { name: 'Start a storyline' })).toBeVisible();
    expect(document.body.textContent).not.toContain('Make this chapter 1');
    expect(document.body.textContent).not.toContain('three-dot menu');
  });
});
