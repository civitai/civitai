import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { describe, expect, it, vi } from 'vitest';
import type * as AppProvider from '~/providers/AppProvider';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';
import type * as BrowserSettingsProvider from '~/providers/BrowserSettingsProvider';
import type * as StickerUtil from '~/components/Sticker/sticker.util';

// Server render only: the bug was a server-drawn .com href that hydration never corrected.
const viewing = vi.hoisted(() => ({ host: 'civitai.red', blurNsfw: false }));

vi.mock('~/providers/AppProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof AppProvider>()),
  useMaybeAppContext: () => ({
    host: viewing.host,
    serverDomains: {
      green: { primary: 'civitai.com', aliases: [] },
      blue: { primary: 'civitai.red', aliases: ['civitaired.com'] },
      red: { primary: 'civitai.red', aliases: [] },
    },
  }),
}));

vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => null,
}));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsProvider>()),
  useFeatureFlags: () => ({}),
}));

vi.mock('~/providers/BrowserSettingsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserSettingsProvider>()),
  useBrowsingSettings: () => viewing.blurNsfw,
}));

vi.mock('~/components/Sticker/sticker.util', async (importOriginal) => ({
  ...(await importOriginal<typeof StickerUtil>()),
  useStickerCosmetics: () => ({ sticker: new Map() }),
}));

const { RenderRichText } = await import('~/components/RichTextEditor/RenderRichText');
const { RenderHtml } = await import('~/components/RenderHtml/RenderHtml');
const { blockedWords } = await import('@civitai/mod-utils/profanity/lists');
const { cleanWord, isUsableBlockedEntry } = await import('@civitai/mod-utils/profanity/word-rules');
const { getProfanityFilter } = await import('~/libs/profanity-simple');
const { CustomMarkdown } = await import('~/components/Markdown/CustomMarkdown');
const { AnnouncementCard } = await import('~/components/Announcements/AnnouncementCard');

const render = (el: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(MantineProvider, null, el));

const hrefOf = (html: string, text: string) =>
  html.match(new RegExp(`<a[^>]*href="([^"]*)"[^>]*>${text}</a>`))?.[1];

const linkParagraph = (href: string, text: string) => ({
  type: 'paragraph',
  content: [{ type: 'text', text, marks: [{ type: 'link', attrs: { href } }] }],
});

describe('content links on civitai.red, server render', () => {
  it('article JSON body', () => {
    const html = render(
      createElement(RenderRichText, {
        content: {
          type: 'doc',
          content: [
            linkParagraph('https://civitai.com/models/1', 'ours'),
            linkParagraph('https://example.com/x', 'theirs'),
            linkParagraph('https://orchestration.civitai.com/x', 'sub'),
          ],
        },
      })
    );
    expect(hrefOf(html, 'ours')).toBe('https://civitai.red/models/1');
    expect(hrefOf(html, 'theirs')).toBe('https://example.com/x');
    expect(hrefOf(html, 'sub')).toBe('https://orchestration.civitai.com/x');
  });

  it('article blurb interior', () => {
    const html = render(
      createElement(RenderRichText, {
        content: {
          type: 'doc',
          content: [
            {
              type: 'blurb',
              attrs: {
                id: 'b1',
                text: '<a href="https://civitai.com/models/1">ours</a> <a href="https://example.com/x">theirs</a>',
              },
            },
          ],
        },
      })
    );
    expect(hrefOf(html, 'ours')).toBe('https://civitai.red/models/1');
    expect(hrefOf(html, 'theirs')).toBe('https://example.com/x');
  });

  it('HTML body (comments, legacy articles)', () => {
    const html = render(
      createElement(RenderHtml, {
        html: '<p><a href="https://civitai.com/models/1">ours</a> <a href="https://example.com/x">theirs</a> <a href="https://civitai.com@evil.test/x">trick</a></p>',
      })
    );
    expect(hrefOf(html, 'ours')).toBe('https://civitai.red/models/1');
    expect(hrefOf(html, 'theirs')).toBe('https://example.com/x');
    expect(hrefOf(html, 'trick')).toBe('https://civitai.com@evil.test/x');
  });

  it('markdown body (announcements)', () => {
    const html = render(
      createElement(
        CustomMarkdown,
        null,
        '[ours](https://civitai.com/models/1) [theirs](https://example.com/x)'
      )
    );
    expect(hrefOf(html, 'ours')).toBe('https://civitai.red/models/1');
    expect(hrefOf(html, 'theirs')).toBe('https://example.com/x');
  });

  it('bare-domain links in a body keep their host', () => {
    const html = render(
      createElement(RenderHtml, {
        html: '<p><a href="https://civitai.com">site</a> <a href="https://civitai.com/models/1">deep</a></p>',
      })
    );
    expect(hrefOf(html, 'site')).toBe('https://civitai.com');
    expect(hrefOf(html, 'deep')).toBe('https://civitai.red/models/1');
  });
});

describe('announcement action buttons', () => {
  const buttonHref = (link: string, host: string) => {
    viewing.host = host;
    try {
      const html = render(
        createElement(AnnouncementCard, {
          title: 'Hello',
          color: 'blue',
          content: 'body',
          actions: [{ link, linkText: 'go' }],
        })
      );
      return html.match(/<a[^>]*href="([^"]*)"/)?.[1];
    } finally {
      viewing.host = 'civitai.red';
    }
  };

  it('a deep link to an article on the other domain stays on the current one', () => {
    expect(buttonHref('https://civitai.com/articles/123', 'civitai.red')).toBe(
      'https://civitai.red/articles/123'
    );
  });

  it('a bare-domain "visit the other site" button keeps its host', () => {
    expect(buttonHref('https://civitai.red', 'civitai.com')).toBe('https://civitai.red');
  });

  it('an external button still goes through the leaving page', () => {
    expect(buttonHref('https://t.me/SomeGroup', 'civitai.red')).toBe(
      '/leaving?url=https://t.me/SomeGroup'
    );
  });
});

// A shipped entry read at runtime, never written down: this repository is public. Assertions on it
// are booleans, so a failure does not print it.
const SHIPPED = blockedWords
  .map(cleanWord)
  .find(
    (word) =>
      isUsableBlockedEntry(word) &&
      /^[a-z]+$/.test(word) &&
      getProfanityFilter().clean(word) !== word
  ) as string;

// Lives here for the stubs above.
describe('RenderHtml comment masking, server render', () => {
  const comment = (maskedHtml?: string | null) =>
    createElement(RenderHtml, {
      html: '<p>a zorblat here</p>',
      maskedHtml,
      withProfanityFilter: true,
    });

  it("shows the server's masked copy when it sent one, and the text as written when it says clean", () => {
    viewing.blurNsfw = true;
    try {
      const masked = render(comment('<p>a ******* here</p>'));
      expect(masked).toContain('a ******* here');
      expect(masked).not.toContain('zorblat');
      expect(render(comment(null))).toContain('a zorblat here');
    } finally {
      viewing.blurNsfw = false;
    }
  });

  it('with no masked copy from the server, masks in the browser with the shipped list', () => {
    const shipped = (maskedHtml?: string | null) =>
      createElement(RenderHtml, {
        html: `<p>a ${SHIPPED} here</p>`,
        maskedHtml,
        withProfanityFilter: true,
      });
    expect(typeof SHIPPED).toBe('string');
    // Control: shown as written to a viewer with masking off.
    expect(render(shipped()).includes(SHIPPED), 'masking off').toBe(true);
    viewing.blurNsfw = true;
    try {
      expect(render(shipped()).includes(SHIPPED), 'no server copy').toBe(false);
      // The server said clean (the managed list dropped it): shown as written.
      expect(render(shipped(null)).includes(SHIPPED), 'server says clean').toBe(true);
    } finally {
      viewing.blurNsfw = false;
    }
  });

  it('shows the text as written to a viewer with masking off, whatever the server sent', () => {
    expect(render(comment('<p>a ******* here</p>'))).toContain('a zorblat here');
  });
});
