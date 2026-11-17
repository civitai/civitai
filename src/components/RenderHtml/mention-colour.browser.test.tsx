import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderWithProviders } from '../../../test/component-setup';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';

vi.mock('~/components/UserAvatar/MentionHoverCard', () => ({ MentionHoverCard: () => null }));
vi.mock('~/providers/BrowserSettingsProvider', () => ({
  useBrowsingSettings: (select: (s: { blurNsfw: boolean }) => unknown) =>
    select({ blurNsfw: false }),
}));

// RenderHtml calls this hook unconditionally and it needs a tRPC context.
vi.mock('~/components/Sticker/sticker.util', async (orig) => ({
  ...(await orig<object>()),
  useStickerCosmetics: () => ({ sticker: {} }),
}));

// Stored descriptions carry the CSS-module class of the build that saved them. A class from
// another build matches no rule here, which is the state every older description is in.
const STALE = 'MentionNode_mention__0old0';
const mention = (name: string) =>
  `<span class="${STALE}" data-type="mention" data-id="1" data-label="${name}">@${name}</span>`;

const colourOf = (el: Element) => getComputedStyle(el).color;

// The harness loads no Mantine stylesheet, so the link token is defined here with a value no
// inherited colour can equal.
const ANCHOR = 'rgb(1, 2, 3)';
beforeEach(() => document.documentElement.style.setProperty('--mantine-color-anchor', ANCHOR));
afterEach(() => document.documentElement.style.removeProperty('--mantine-color-anchor'));

describe('RenderHtml mentions', () => {
  test.each([
    ['plain paragraph', `<p>thanks ${mention('Alpha')}</p>`],
    ['bold list item', `<ul><li><p><strong>thanks ${mention('Alpha')}</strong></p></li></ul>`],
  ])('a stored mention with a stale class keeps the link colour in a %s', async (_name, html) => {
    await renderWithProviders(<RenderHtml html={html} />);
    const el = document.querySelector<HTMLElement>('[data-type="mention"]')!;
    expect(el).not.toBeNull();
    expect(colourOf(el)).toBe(ANCHOR);
  });
});
