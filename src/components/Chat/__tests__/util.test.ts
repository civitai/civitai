import { MantineProvider } from '@mantine/core';
import { find as findLinks } from 'linkifyjs';
import Linkify from 'linkify-react';
import type { ReactElement } from 'react';
import { createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  chatLinkifyOptions,
  chatPreviewText,
  getLinkHref,
  isChatLink,
  MODERATOR_BADGE_COSMETIC_ID,
  showsChatModeratorMark,
} from '~/components/Chat/util';

// Every host our sites answer on, as `getOwnHosts` reads it from the domain config.
const ownHosts = ['civitai.com', 'civitai.red', 'civitai.green'];
const linkifyOptions = chatLinkifyOptions(ownHosts);
const renderLink = linkifyOptions.render as (ir: unknown) => ReactElement;

// linkify only turns a URL into a link when isChatLink passes; this is the
// gate the fix actually flips, so a revert (dropping `civitai.red` from
// externalRegex) makes the first assertion below fail.
describe('isChatLink', () => {
  it('accepts civitai.red URLs so they get linkified in chat', () => {
    expect(isChatLink('https://civitai.red/models/123', ownHosts)).toBe(true);
    expect(isChatLink('https://civitai.red/user/someone', ownHosts)).toBe(true);
  });

  it('accepts education.civitai.com URLs so guide links get linkified in chat', () => {
    expect(
      isChatLink('https://education.civitai.com/civitais-guide-to-resource-types/#Loras', ownHosts)
    ).toBe(true);
    expect(isChatLink('education.civitai.com', ownHosts)).toBe(true);
  });

  it('still accepts existing allowlist domains and civitai.com/AIR', () => {
    expect(isChatLink('https://github.com/civitai/civitai', ownHosts)).toBe(true);
    expect(isChatLink('https://civitai.com/models/123', ownHosts)).toBe(true);
    expect(isChatLink('civitai:123@456', ownHosts)).toBe(true);
  });

  it('rejects a look-alike host that only prefixes civitai.red', () => {
    // Without the domain boundary this would validate and then be server-side
    // fetched by unfurl() as if it were the trusted .red domain.
    expect(isChatLink('https://civitai.red.evil.com/x', ownHosts)).toBe(false);
    expect(isChatLink('https://example.com/x', ownHosts)).toBe(false);
    expect(isChatLink('https://education.civitai.com.evil.com/x', ownHosts)).toBe(false);
  });

  // Hosts are matched exactly on the parsed URL, so a name that merely starts with an
  // allowlisted host, or puts one in the credentials, is not a link.
  it.each([
    'https://civitai.com.example.org/x',
    'https://civitai.community/x',
    'civitai.com.example.org/x',
    'https://image.civitai.com.example.org/x',
    'https://github.com.example.org/x',
    'https://x.com.example.org/x',
    'https://twitter.com.example.org/x',
    'https://civitai.red.example.org/x',
    'https://education.civitai.com.example.org/x',
    'https://www.github.com.example.org/x',
    'https://notgithub.com/x',
  ])('rejects the look-alike host %s', (url) => {
    expect(isChatLink(url, ownHosts)).toBe(false);
    expect(getLinkHref(url, ownHosts)).toBeUndefined();
  });

  it.each([
    'https://civitai.com:x@other.host/',
    'https://civitai.com@other.host/',
    'https://github.com:x@other.host/',
    'https://twitter.com:x@other.host/',
    'https://x.com:x@other.host/',
    'https://civitai.red:x@other.host/',
    'https://education.civitai.com:x@other.host/',
    'https://user:pass@github.com/x',
  ])('rejects a URL carrying credentials: %s', (url) => {
    expect(isChatLink(url, ownHosts)).toBe(false);
    expect(getLinkHref(url, ownHosts)).toBeUndefined();
  });

  it.each([
    'https://civitai.com',
    'https://civitai.com/',
    'civitai.com/models/123',
    'http://civitai.com/models/123?modelVersionId=4#gallery',
    'https://civitai.com:443/models/123',
    'https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/abc/width=450/1.jpeg',
    'https://github.com',
    'github.com/civitai/civitai/pull/1?tab=files#diff',
    'https://www.github.com/civitai',
    'https://github.com:443/civitai',
    'https://x.com/civitai/status/1',
    'https://twitter.com/civitai',
    'https://civitai.red/models/123?sort=new',
    'https://education.civitai.com/guide/#Loras',
  ])('accepts the genuine URL %s', (url) => {
    expect(isChatLink(url, ownHosts)).toBe(true);
    expect(getLinkHref(url, ownHosts)).toBeDefined();
  });
});

describe('renderLink', () => {
  it('renders a civitai.red URL as an off-site anchor that opens in a new tab', () => {
    const el = renderLink({
      attributes: { href: 'https://civitai.red/models/123' },
      content: 'https://civitai.red/models/123',
    } as never) as ReactElement<{ href: string; target: string }>;
    expect(el.props.href).toBe('https://civitai.red/models/123');
    expect(el.props.target).toBe('_blank');
  });

  it('renders an off-allowlist href as its text, still an element linkify-react can key', () => {
    const el = renderLink({
      attributes: { href: 'https://example.com/x' },
      content: 'https://example.com/x',
    } as never);
    expect(isValidElement(el)).toBe(true);
    expect(renderToStaticMarkup(el)).toBe('https://example.com/x');
  });
});

// Rendered the way ExistingChat renders a message body.
const renderMessage = (text: string) =>
  renderToStaticMarkup(
    createElement(MantineProvider, null, createElement(Linkify, { options: linkifyOptions }, text))
  );

describe('a chat message through Linkify', () => {
  it.each([
    'mail me at someone@example.com please',
    'see https://example.com/x',
    'see https://civitai.red.evil.com/x',
  ])('renders %s as plain text without throwing', (text) => {
    const html = renderMessage(text);
    expect(html).not.toContain('<a');
    expect(html).toContain(text);
  });

  it('still links allowlisted URLs', () => {
    const html = renderMessage('https://civitai.com/models/123 and https://github.com/civitai');
    expect(html).toContain('href="/models/123"');
    expect(html).toContain('href="https://github.com/civitai"');
  });

  it('hands only allowlisted URLs to the server-side unfurl', () => {
    const links = findLinks(
      'someone@example.com https://example.com/x https://civitai.red.evil.com/x https://github.com/civitai',
      linkifyOptions
    );
    expect(links.map((l) => l.href)).toEqual(['https://github.com/civitai']);
  });
});

describe('getLinkHref', () => {
  it('preserves the full off-site URL for civitai.red so it opens on the .red domain', () => {
    expect(getLinkHref('https://civitai.red/models/123', ownHosts)).toBe(
      'https://civitai.red/models/123'
    );
  });

  it('rewrites civitai.com links to an internal relative path', () => {
    expect(getLinkHref('https://civitai.com/models/123', ownHosts)).toBe('/models/123');
  });

  it('keeps the query and fragment of a civitai.com link, and drops a port', () => {
    expect(getLinkHref('https://civitai.com/models/123?modelVersionId=4#gallery', ownHosts)).toBe(
      '/models/123?modelVersionId=4#gallery'
    );
    expect(getLinkHref('https://civitai.com:443/models/123', ownHosts)).toBe('/models/123');
    expect(getLinkHref('https://civitai.com', ownHosts)).toBe('/');
  });

  it('resolves AIR URNs to a model URL', () => {
    expect(getLinkHref('civitai:123@456', ownHosts)).toContain('/models/123');
  });

  it('returns undefined for an empty href', () => {
    expect(getLinkHref(undefined, ownHosts)).toBeUndefined();
  });
});

describe('a civitai.com link whose path starts with two slashes', () => {
  // A browser reads an href of "//host/x" as another host, so these must never become one.
  const shapes = [
    'https://civitai.com//example.org/x',
    'civitai.com//example.org/x',
    'https://civitai.com/.//example.org/x',
    'https://civitai.com/a/..//example.org/x',
    'https://civitai.com/\\example.org/x',
    '/.//example.org/x',
  ];

  it.each(shapes)('gives %s no href', (href) => {
    expect(getLinkHref(href, ownHosts)).toBeUndefined();
    expect(isChatLink(href, ownHosts)).toBe(false);
  });

  it.each(shapes.slice(0, 5))('renders %s in a message without a link', (text) => {
    const html = renderMessage(`see ${text}`);
    expect(html).not.toContain('href="//');
    expect(html).not.toContain('<a');
  });

  it('still links a normal civitai.com path, and keeps an encoded slash on the site', () => {
    expect(getLinkHref('https://civitai.com/models/1', ownHosts)).toBe('/models/1');
    expect(getLinkHref('civitai.com/models/1', ownHosts)).toBe('/models/1');
    expect(getLinkHref('https://civitai.com/%2F%2Fexample.org', ownHosts)).toBe(
      '/%2F%2Fexample.org'
    );
    expect(
      getLinkHref('https://civitai.com/models/1?back=https://civitai.com/x#//y', ownHosts)
    ).toBe('/models/1?back=https://civitai.com/x#//y');
    expect(renderMessage('see civitai.com/models/1')).toContain('href="/models/1"');
  });
});

describe('a link to another of our sites', () => {
  const anchorFor = (text: string, hosts: string[]) => {
    const html = renderToStaticMarkup(
      createElement(
        MantineProvider,
        null,
        createElement(Linkify, { options: chatLinkifyOptions(hosts) }, text)
      )
    );
    const href = html.match(/<a [^>]*href="([^"]*)"/)?.[1] ?? null;
    return { href, newTab: /<a [^>]*target="_blank"/.test(html) };
  };

  it.each([
    ['https://civitai.green/models/1', 'https://civitai.green/models/1'],
    ['https://civitai.red/models/1', 'https://civitai.red/models/1'],
    ['https://www.civitai.red/models/1', 'https://www.civitai.red/models/1'],
  ])('links %s as written, in a new tab', (text, href) => {
    expect(anchorFor(text, ownHosts)).toEqual({ href, newTab: true });
  });

  it('links a bare civitai.green host too, in a new tab', () => {
    const { href, newTab } = anchorFor('civitai.green/models/1', ownHosts);
    expect(href).toContain('civitai.green/models/1');
    expect(newTab).toBe(true);
  });

  it('links any host in ownHosts, aliases included, and none outside it', () => {
    expect(anchorFor('https://green.example.org/a', [...ownHosts, 'green.example.org'])).toEqual({
      href: 'https://green.example.org/a',
      newTab: true,
    });
    expect(anchorFor('https://civitai.green/models/1', []).href).toBeNull();
  });

  it('leaves www.civitai.com unlinked, as before', () => {
    expect(anchorFor('https://www.civitai.com/models/1', ownHosts).href).toBeNull();
  });

  it('still opens a civitai.com link on the site being read', () => {
    expect(anchorFor('https://civitai.com/models/1', ownHosts)).toEqual({
      href: '/models/1',
      newTab: false,
    });
  });

  it('hands our other sites to the server-side link preview', () => {
    const links = findLinks('https://civitai.green/models/1 https://example.com/x', linkifyOptions);
    expect(links.map((l) => l.href)).toEqual(['https://civitai.green/models/1']);
  });
});

describe('chatPreviewText', () => {
  const me = 1;
  const ann = { userId: 2, user: { username: 'ann' } };
  const bob = { userId: 3, user: { username: 'bob' } };
  const say = (userId: number, others: (typeof ann)[]) =>
    chatPreviewText({
      message: { content: 'hi', userId },
      viewerId: me,
      otherMembers: others,
    });

  it('prefixes your own message with "You: "', () => {
    expect(say(me, [ann])).toBe('You: hi');
    expect(say(me, [ann, bob])).toBe('You: hi');
  });

  it('names the sender in a group', () => {
    expect(say(3, [ann, bob])).toBe('bob: hi');
  });

  it('leaves the other person in a 1:1 unprefixed', () => {
    expect(say(2, [ann])).toBe('hi');
  });

  it('does not invent a sender for a system row', () => {
    expect(say(-1, [ann, bob])).toBe('hi');
  });

  it('shows the deal-accepted message without its markdown', () => {
    const text = chatPreviewText({
      message: {
        content: 'Deal accepted: **A cat portrait**. [Open the deal](/services/deals/12)',
        userId: -1,
      },
      viewerId: me,
      otherMembers: [ann],
    });
    expect(text).toBe('Deal accepted: A cat portrait. Open the deal');
  });
});

describe('showsChatModeratorMark', () => {
  const badge = (id: number, type = 'Badge') => ({ cosmetic: { id, type } });

  it('adds the mark for a moderator with no badge, or another badge', () => {
    expect(showsChatModeratorMark({ isModerator: true, cosmetics: [] })).toBe(true);
    expect(showsChatModeratorMark({ isModerator: true, cosmetics: [badge(7)] })).toBe(true);
  });

  it('skips it when the equipped Moderator badge already shows one', () => {
    expect(
      showsChatModeratorMark({ isModerator: true, cosmetics: [badge(MODERATOR_BADGE_COSMETIC_ID)] })
    ).toBe(false);
  });

  it('is not tripped by a non-badge cosmetic that shares the id', () => {
    expect(
      showsChatModeratorMark({
        isModerator: true,
        cosmetics: [badge(MODERATOR_BADGE_COSMETIC_ID, 'NamePlate')],
      })
    ).toBe(true);
  });

  it('never adds a mark for a non-moderator', () => {
    expect(showsChatModeratorMark({ isModerator: false, cosmetics: [] })).toBe(false);
    expect(
      showsChatModeratorMark({
        isModerator: false,
        cosmetics: [badge(MODERATOR_BADGE_COSMETIC_ID)],
      })
    ).toBe(false);
  });
});
