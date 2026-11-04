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
  HoverCreatorCard: ({ username }: { username: string | null }) => (
    <div data-testid="creator-card">{username}</div>
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
    expect(link?.getAttribute('href')).toBe('/user/Alpha');
  });

  test('a label that needs encoding keeps the link on the profile path', async () => {
    await render('a?b');
    const link = document.querySelector<HTMLAnchorElement>('a[data-type="mention"]');
    expect(link?.getAttribute('href')).toBe('/user/a%3Fb');
  });

  test.each(['Alpha', 'a?b'])('the hover card still resolves for %s', async (label) => {
    await render(label);
    await userEvent.hover(document.querySelector<HTMLElement>('a[data-type="mention"]')!);
    await expect.poll(() => document.querySelector('[data-testid="creator-card"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="creator-card"]')?.textContent).toBe(label);
  });
});
