import { describe, expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { renderWithProviders } from '../../../test/component-setup';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';

vi.mock('~/providers/BrowserSettingsProvider', () => ({
  useBrowsingSettings: (select: (s: { blurNsfw: boolean }) => unknown) =>
    select({ blurNsfw: false }),
}));

vi.mock('~/components/Sticker/sticker.util', async (orig) => ({
  ...(await orig<object>()),
  useStickerCosmetics: () => ({ sticker: {} }),
}));

// The real MentionHoverCard runs; only the profile fetch behind it is stubbed.
vi.mock('~/components/UserAvatar/UserHoverCard', async (orig) => ({
  ...(await orig<object>()),
  useHoverCapable: () => true,
  HoverCreatorCard: ({
    username,
    expectUsername,
  }: {
    username: string | null;
    expectUsername?: string;
  }) => (
    <div data-testid="creator-card" data-expect={expectUsername}>
      {username}
    </div>
  ),
}));

const mention = (label: string) =>
  `<span data-type="mention" data-id="1" data-label="${label}">@${label}</span>`;

const render = (label: string) =>
  renderWithProviders(<RenderHtml html={`<p>thanks ${mention(label)}</p>`} withMentions />);

describe('description mentions', () => {
  test('a mention links to the profile', async () => {
    await render('Alpha');
    const link = document.querySelector<HTMLAnchorElement>('a[data-type="mention"]');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('/user/Alpha');
  });

  test('without withMentions the mention stays a span', async () => {
    await renderWithProviders(<RenderHtml html={`<p>thanks ${mention('Alpha')}</p>`} />);
    expect(document.querySelector('a[data-type="mention"]')).toBeNull();
    expect(document.querySelector('span[data-type="mention"]')).not.toBeNull();
  });

  test('a label that needs encoding keeps the link on the profile path', async () => {
    await render('a?b');
    const link = document.querySelector<HTMLAnchorElement>('a[data-type="mention"]');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe('/user/a%3Fb');
  });

  test.each(['Alpha', 'a?b'])('the hover card still resolves for %s', async (label) => {
    await render(label);
    await userEvent.hover(document.querySelector<HTMLElement>('a[data-type="mention"]')!);
    await expect
      .poll(() => document.querySelector('[data-testid="creator-card"]'), { timeout: 5000 })
      .not.toBeNull();
    expect(document.querySelector('[data-testid="creator-card"]')?.textContent).toBe(label);
  });

  // A stored mention keeps the name it was written with; the user may have been renamed since.
  const stored = (id: number, label: string) =>
    `<span data-type="mention" data-id="mention:${id}" data-label="${label}">@${label}</span>`;

  test('a stored mention links by user id, so a rename does not move it', async () => {
    await renderWithProviders(<RenderHtml html={`<p>${stored(7, 'OldName')}</p>`} withMentions />);
    const link = document.querySelector<HTMLAnchorElement>('a[data-type="mention"]');
    expect(link!.getAttribute('href')).toBe('/user-link/7');
    expect(link!.textContent).toBe('@OldName');
  });

  test('the hover card still resolves for an id link', async () => {
    await renderWithProviders(<RenderHtml html={`<p>${stored(7, 'OldName')}</p>`} withMentions />);
    await userEvent.hover(document.querySelector<HTMLElement>('a[data-type="mention"]')!);
    await expect
      .poll(() => document.querySelector('[data-testid="creator-card"]'), { timeout: 5000 })
      .not.toBeNull();
    // The card is keyed on the id, so the stored label (a pre-rename name) must not gate it.
    expect(
      document.querySelector('[data-testid="creator-card"]')?.hasAttribute('data-expect')
    ).toBe(false);
  });

  test('a label link still makes the card check the name', async () => {
    await render('Alpha');
    await userEvent.hover(document.querySelector<HTMLElement>('a[data-type="mention"]')!);
    await expect
      .poll(() => document.querySelector('[data-testid="creator-card"]'), { timeout: 5000 })
      .not.toBeNull();
    expect(
      document.querySelector('[data-testid="creator-card"]')?.getAttribute('data-expect')
    ).toBe('Alpha');
  });

  test('no card when an id link points at a different user', async () => {
    const forged = `<a href="/user-link/8">${stored(7, 'OldName')}</a>`;
    await renderWithProviders(<RenderHtml html={`<p>${forged}</p>`} />);
    await userEvent.hover(document.querySelector<HTMLElement>('span[data-type="mention"]')!);
    await new Promise((r) => setTimeout(r, 800));
    expect(document.querySelector('[data-testid="creator-card"]')).toBeNull();
  });
});
