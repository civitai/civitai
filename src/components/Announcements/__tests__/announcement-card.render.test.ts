import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MantineProvider } from '@mantine/core';
import { describe, expect, it, vi } from 'vitest';
import type * as CurrentUser from '~/hooks/useCurrentUser';
import type * as FeatureFlagsProvider from '~/providers/FeatureFlagsProvider';
import type { AnnouncementCardAction } from '~/components/Announcements/AnnouncementCard';

// The browser-mode twin (`AnnouncementCard.browser.test.tsx`) covers the clicks but runs in no
// gating CI job, so the rendered shape both tickets turn on is pinned here, in `unit`.

vi.mock('~/hooks/useCurrentUser', async (importOriginal) => ({
  ...(await importOriginal<typeof CurrentUser>()),
  useCurrentUser: () => null,
}));

vi.mock('~/providers/FeatureFlagsProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsProvider>()),
  useFeatureFlags: () => ({}),
}));

const { AnnouncementCard } = await import('~/components/Announcements/AnnouncementCard');
const { CustomMarkdown } = await import('~/components/Markdown/CustomMarkdown');

function render(props: { content: string; actions?: AnnouncementCardAction[] }) {
  return renderToStaticMarkup(
    createElement(
      MantineProvider,
      null,
      createElement(AnnouncementCard, { title: 'Hello', color: 'blue', ...props })
    )
  );
}

describe('AnnouncementCard body line breaks', () => {
  it('renders a single typed newline as a line break', () => {
    expect(render({ content: 'first line\nsecond line' })).toContain('first line<br/>');
  });

  it('renders a blank line as two paragraphs', () => {
    expect(render({ content: 'para one\n\npara two' })).toMatch(
      /<p>para one<\/p>\s*<p>para two<\/p>/
    );
  });

  it('still strips markup other than links and breaks', () => {
    const html = render({ content: '# heading\n\n**bold** and [a link](https://t.me/x)' });
    expect(html).not.toMatch(/<h1|<strong/);
    expect(html).toContain('a link</a>');
  });
});

describe('AnnouncementCard off-site link in the body', () => {
  it('links to the leaving-Civitai page rather than the destination', () => {
    const html = render({ content: 'grab them at [my telegram](https://t.me/SomeGroup)' });
    const href = html.match(/<a[^>]*href="([^"]*)"[^>]*>my telegram<\/a>/)?.[1];
    expect(href).toBe('/leaving?url=https://t.me/SomeGroup');
  });
});

describe('AnnouncementCard off-site action', () => {
  const external = { link: 'https://t.me/SomeGroup?a=1&b=2', linkText: 'Join the group' };

  it('is an anchor whose href is the leaving-Civitai page for that destination', () => {
    const html = render({ content: 'x', actions: [external] });
    const href = html.match(/<a[^>]*href="([^"]*)"[^>]*>(?:(?!<\/a>).)*Join the group/)?.[1];
    expect(href).toBe('/leaving?url=https://t.me/SomeGroup%3Fa%3D1%26b%3D2');
  });

  it('leaves an on-site action linking straight to its path', () => {
    const html = render({ content: 'x', actions: [{ link: '/models/1', linkText: 'See it' }] });
    expect(html).toMatch(/<a[^>]*href="\/models\/1"[^>]*>(?:(?!<\/a>).)*See it/);
  });
});

// 🔴 `warnOnExternalLinks` is opt-in, and only announcements opt in. Without the flag, articles,
// comments and bios must keep the raw destination; this is the gating half of that boundary.
describe('CustomMarkdown without warnOnExternalLinks', () => {
  it('keeps an external link pointing straight at its destination', () => {
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(
          CustomMarkdown,
          { allowedElements: ['a'], unwrapDisallowed: true },
          'grab them at [my telegram](https://t.me/SomeGroup)'
        )
      )
    );
    expect(html).toContain('href="https://t.me/SomeGroup"');
    expect(html).not.toContain('/leaving');
  });
});
