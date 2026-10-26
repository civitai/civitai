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
