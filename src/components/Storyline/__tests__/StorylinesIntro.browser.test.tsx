import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { MantineProvider } from '@mantine/core';
import { renderToString } from 'react-dom/server';
import { renderWithProviders } from '../../../../test/component-setup';
import {
  STORYLINES_INTRO_DISMISSED_KEY,
  StorylinesIntro,
} from '~/components/Storyline/StorylinesIntro';

/**
 * The welcome card on /storylines. The "start one" link shows only when signed in: it goes to the
 * reader's own posts (see StorylinesIntro.tsx).
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

  test('signed out, "Start a storyline" asks them to sign in instead of linking anywhere', async () => {
    renderWithProviders(<StorylinesIntro />);

    await expect
      .element(
        page.getByTestId('login-redirect').getByRole('button', { name: 'Start a storyline' })
      )
      .toBeVisible();
    expect(page.getByRole('link', { name: 'Start a storyline' }).elements()).toHaveLength(0);
  });

  test('signed in, "Start a storyline" goes to their own posts, where a storyline starts', async () => {
    mocks.user = { username: 'civbot' };
    renderWithProviders(<StorylinesIntro />);

    await expect
      .element(page.getByRole('link', { name: 'Start a storyline' }))
      .toHaveAttribute('href', '/user/civbot/posts');
    expect(page.getByTestId('login-redirect').elements()).toHaveLength(0);
  });

  test('the button is described by where a storyline starts: a published post', async () => {
    mocks.user = { username: 'civbot' };
    renderWithProviders(<StorylinesIntro />);

    await expect
      .element(page.getByRole('link', { name: 'Start a storyline' }))
      .toHaveAccessibleDescription(/published post.*Make this chapter 1 of a storyline/);
  });
});
