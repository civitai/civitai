/**
 * Is this User-Agent a crawler, link unfurler or other automated fetcher?
 *
 * For ATTRIBUTION only — deciding whether a request should count as a person using something
 * (an off-site app visit). It is a UA string test: trivially spoofable in either direction, so it
 * must never gate access or anything a forger benefits from. `verifyBot` (beside this file) is
 * the IP-verified check for the two search crawlers we grant privileges to; this is the broad,
 * unverified net that keeps chat-client link previews and crawlers out of a usage count.
 *
 * Named agents first (their UAs do not all contain "bot"), then the generic words.
 */
const AUTOMATED_AGENT_PATTERNS: readonly RegExp[] = [
  /Discordbot/i,
  /Slackbot/i,
  /Slack-ImgProxy/i,
  /facebookexternalhit/i,
  /Facebot/i,
  /Twitterbot/i,
  /LinkedInBot/i,
  /TelegramBot/i,
  // The preview fetcher's UA STARTS with it; WhatsApp's in-app browser (a person) does not.
  /^WhatsApp\//i,
  /redditbot/i,
  /Embedly/i,
  /SkypeUriPreview/i,
  /HeadlessChrome/i,
  /\b(bot|crawler|spider|preview|scraper)\b/i,
  // `FooBot/1.0`, `Foo-Crawler;` — the product-token form. A slash or semicolon is required so
  // a device name that merely ends in "bot" (a CUBOT phone) is not caught.
  /(bot|crawler|spider)[/;]/i,
];

export function isAutomatedUserAgent(ua: string | string[] | null | undefined): boolean {
  const value = Array.isArray(ua) ? ua[0] : ua;
  if (!value) return false;
  return AUTOMATED_AGENT_PATTERNS.some((re) => re.test(value));
}
