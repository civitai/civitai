import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildFeedGoApiPolicy,
  FEED_GO_API_POLICY_PATH,
  renderFeedGoApiPolicy,
} from '../feed-go-api-policy';

// The Go feed service's public route reads its region block list and crawler user agents from this
// committed file; a change to DEFAULT_REGION_BLOCK_CONFIG or BOT_UA_PATTERNS must regenerate it, or the
// Go service serves a feed where the app answers 451, or answers a crawler as a plain visitor.
describe('apps/feed-go apipolicy.json', () => {
  it('is what the Node policy modules hold today (regenerate: pnpm exec tsx scripts/feed-go-api-policy.ts)', () => {
    expect(readFileSync(FEED_GO_API_POLICY_PATH, 'utf8')).toBe(renderFeedGoApiPolicy());
  });

  // Positive control: the file is built from the modules, so known facts must be in it, pinned as
  // literals.
  it('holds the facts the Go route reads', () => {
    const policy = buildFeedGoApiPolicy();
    expect(policy.regionBlockDefault).toContainEqual({ region: 'GB', effectiveDate: '2025-07-24' });
    expect(policy.privateCacheControl).toBe('max-age=0, private, no-cache');
    expect(policy.botUserAgentPatterns.map((p) => p.name)).toEqual(['bingbot', 'googlebot']);
    const google = policy.botUserAgentPatterns.find((p) => p.name === 'googlebot');
    expect(google?.ignoreCase).toBe(true);
    expect(
      new RegExp(google?.source ?? '$^', 'i').test('Mozilla/5.0 (compatible; googlebot/2.1)')
    ).toBe(true);
  });
});
