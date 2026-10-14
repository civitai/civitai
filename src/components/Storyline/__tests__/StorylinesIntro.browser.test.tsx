import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { renderWithProviders } from '../../../../test/component-setup';
import {
  STORYLINES_INTRO_DISMISSED_KEY,
  StorylinesIntro,
} from '~/components/Storyline/StorylinesIntro';

/**
 * The welcome card on /storylines: shown until dismissed, remembered across visits, and the
 * "start one" link only for someone signed in (it goes to their own posts).
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
    renderWithProviders(<StorylinesIntro />);
    // Give the storage read its effect before asserting the absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(document.body.textContent).not.toContain('Welcome to Storylines');
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
});
