import { describe, expect, it } from 'vitest';
import { isMobileUserAgent } from '~/shared/utils/mobile-user-agent';

describe('isMobileUserAgent', () => {
  it.each([
    [
      'Googlebot smartphone',
      'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 Chrome/142.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    ],
    [
      'Android tablet without the Mobile token',
      'Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 Chrome/142.0 Safari/537.36',
    ],
  ])('is true for %s', (_, ua) => {
    expect(isMobileUserAgent(ua)).toBe(true);
  });

  it.each([
    [
      'Googlebot desktop',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/142.0 Safari/537.36',
    ],
    [
      'iPad in desktop mode',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
    ],
    ['no header', undefined],
  ])('is false for %s', (_, ua) => {
    expect(isMobileUserAgent(ua)).toBe(false);
  });
});
