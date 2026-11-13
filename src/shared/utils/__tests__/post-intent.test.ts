import { describe, expect, it } from 'vitest';
import {
  appendSourceLink,
  openIntentQuerySchema,
  resolveIntentMode,
} from '~/shared/utils/post-intent';

const manifest = 'https://games.civitai.com/api/share/sh_1.json';

describe('resolveIntentMode', () => {
  it('uses app mode for a manifest link when the flag is on', () => {
    expect(resolveIntentMode({ manifest }, true)).toEqual({ mode: 'app', manifestUrl: manifest });
  });

  it('falls back to open mode when the flag is off', () => {
    expect(resolveIntentMode({ manifest, media: 'https://x.test/a.png' }, false)).toEqual({
      mode: 'open',
    });
  });
});

describe('openIntentQuerySchema', () => {
  it('accepts repeated media and the old mediaUrl together, without duplicates', () => {
    const parsed = openIntentQuerySchema.parse({
      mediaUrl: 'https://x.test/a.png',
      media: ['https://x.test/a.png', 'https://x.test/b.mp4'],
    });
    expect(parsed.mediaUrls).toEqual(['https://x.test/a.png', 'https://x.test/b.mp4']);
  });

  it('refuses more than 10 media urls', () => {
    const media = Array.from({ length: 11 }, (_, i) => `https://x.test/${i}.png`);
    expect(openIntentQuerySchema.safeParse({ media }).success).toBe(false);
  });

  it('refuses a non-https link back', () => {
    const result = openIntentQuerySchema.safeParse({
      media: 'https://x.test/a.png',
      link: 'javascript:alert(1)',
    });
    expect(result.success).toBe(false);
  });
});

describe('appendSourceLink', () => {
  it('adds an escaped Source link marked as user content', () => {
    expect(appendSourceLink('Hi', 'https://x.test/?a=1&b="2"')).toBe(
      'Hi\n<p>Source: <a href="https://x.test/?a=1&amp;b=&quot;2&quot;" rel="ugc nofollow noopener" target="_blank">https://x.test/?a=1&amp;b=&quot;2&quot;</a></p>'
    );
  });
});
