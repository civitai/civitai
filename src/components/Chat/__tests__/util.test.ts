import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import {
  chatPreviewText,
  getLinkHref,
  MODERATOR_BADGE_COSMETIC_ID,
  renderLink,
  showsChatModeratorMark,
  validateLink,
} from '~/components/Chat/util';

// linkify only turns a URL into a link when validateLink.url passes; this is the
// gate the fix actually flips, so a revert (dropping `civitai.red` from
// externalRegex) makes the first assertion below fail.
describe('validateLink.url', () => {
  it('accepts civitai.red URLs so they get linkified in chat', () => {
    expect(validateLink.url('https://civitai.red/models/123')).toBe(true);
    expect(validateLink.url('https://civitai.red/user/someone')).toBe(true);
  });

  it('accepts education.civitai.com URLs so guide links get linkified in chat', () => {
    expect(
      validateLink.url('https://education.civitai.com/civitais-guide-to-resource-types/#Loras')
    ).toBe(true);
    expect(validateLink.url('education.civitai.com')).toBe(true);
  });

  it('still accepts existing allowlist domains and civitai.com/AIR', () => {
    expect(validateLink.url('https://github.com/civitai/civitai')).toBe(true);
    expect(validateLink.url('https://civitai.com/models/123')).toBe(true);
    expect(validateLink.url('civitai:123@456')).toBe(true);
  });

  it('rejects a look-alike host that only prefixes civitai.red', () => {
    // Without the domain boundary this would validate and then be server-side
    // fetched by unfurl() as if it were the trusted .red domain.
    expect(validateLink.url('https://civitai.red.evil.com/x')).toBe(false);
    expect(validateLink.url('https://example.com/x')).toBe(false);
    expect(validateLink.url('https://education.civitai.com.evil.com/x')).toBe(false);
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
    expect(validateLink.url(url)).toBe(false);
    expect(getLinkHref(url)).toBeUndefined();
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
    expect(validateLink.url(url)).toBe(false);
    expect(getLinkHref(url)).toBeUndefined();
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
    expect(validateLink.url(url)).toBe(true);
    expect(getLinkHref(url)).toBeDefined();
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
});

describe('getLinkHref', () => {
  it('preserves the full off-site URL for civitai.red so it opens on the .red domain', () => {
    expect(getLinkHref('https://civitai.red/models/123')).toBe('https://civitai.red/models/123');
  });

  it('rewrites civitai.com links to an internal relative path', () => {
    expect(getLinkHref('https://civitai.com/models/123')).toBe('/models/123');
  });

  it('keeps the query and fragment of a civitai.com link, and drops a port', () => {
    expect(getLinkHref('https://civitai.com/models/123?modelVersionId=4#gallery')).toBe(
      '/models/123?modelVersionId=4#gallery'
    );
    expect(getLinkHref('https://civitai.com:443/models/123')).toBe('/models/123');
    expect(getLinkHref('https://civitai.com')).toBe('/');
  });

  it('resolves AIR URNs to a model URL', () => {
    expect(getLinkHref('civitai:123@456')).toContain('/models/123');
  });

  it('returns undefined for an empty href', () => {
    expect(getLinkHref(undefined)).toBeUndefined();
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
