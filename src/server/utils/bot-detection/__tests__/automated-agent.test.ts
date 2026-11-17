import { describe, expect, it } from 'vitest';

import { isAutomatedUserAgent } from '../automated-agent';

describe('isAutomatedUserAgent', () => {
  it.each([
    'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
    'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'Slack-ImgProxy (+https://api.slack.com/robots)',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Twitterbot/1.0',
    'LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)',
    'TelegramBot (like TwitterBot)',
    'WhatsApp/2.23.20.0',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
    'Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)',
    'some-crawler/1.0',
    'Example Spider (+https://example.invalid)',
    'Mozilla/5.0 HeadlessChrome/120.0',
    'LinkPreview bot',
  ])('flags %s', (ua) => {
    expect(isAutomatedUserAgent(ua)).toBe(true);
  });

  it.each([
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    // "Cubot" is a phone maker: a word ending in "bot" inside a device name is not a bot.
    'Mozilla/5.0 (Linux; Android 12; CUBOT KINGKONG 7) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36',
  ])('does not flag a browser: %s', (ua) => {
    expect(isAutomatedUserAgent(ua)).toBe(false);
  });

  it('treats a missing UA as not automated (the event is still recorded)', () => {
    expect(isAutomatedUserAgent(undefined)).toBe(false);
    expect(isAutomatedUserAgent('')).toBe(false);
    expect(isAutomatedUserAgent(['Discordbot/2.0'])).toBe(true);
  });
});
