import { describe, expect, it } from 'vitest';
import { playerBadge } from './player-badge';

const keyToUrl = (key: string, width: number) => `cdn/${key}/w${width}`;
const base = 'https://civitai.com';

describe('playerBadge', () => {
  it('builds a CDN url for an image key', () => {
    expect(playerBadge({ username: 'Ada', image: 'abc-123' }, base, keyToUrl)).toEqual({
      username: 'Ada',
      avatarUrl: 'cdn/abc-123/w48',
      profileUrl: 'https://civitai.com/user/Ada',
    });
  });
  it('passes a full url through', () => {
    expect(
      playerBadge({ username: 'Ada', image: 'https://x.test/a.png' }, base, keyToUrl)?.avatarUrl
    ).toBe('https://x.test/a.png');
  });
  it('has no avatar without an image', () => {
    expect(playerBadge({ username: 'Ada' }, base, keyToUrl)?.avatarUrl).toBeNull();
  });
  it('is null without a username', () => {
    expect(playerBadge({ image: 'k' }, base, keyToUrl)).toBeNull();
    expect(playerBadge({ username: '  ' }, base, keyToUrl)).toBeNull();
    expect(playerBadge(undefined, base, keyToUrl)).toBeNull();
  });
  it('encodes the username in the profile url', () => {
    expect(playerBadge({ username: 'a b' }, base, keyToUrl)?.profileUrl).toBe(
      'https://civitai.com/user/a%20b'
    );
  });
});
