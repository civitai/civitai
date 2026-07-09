import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHAT_SETTINGS,
  resolveChatSettings,
} from '~/server/schema/chat.schema';

// `resolveChatSettings` is the SHARED source used by BOTH the
// `chat.getUserSettings` tRPC resolver AND the `_app` SSR bootstrap seed. The
// seed primes the client query cache with this value; if it ever drifted from
// what the resolver returns, the primed cache would mismatch and React Query
// would fire the bootstrap refetch the seed exists to cut (#2471). These tests
// pin that byte-equality contract.
describe('resolveChatSettings (chat.getUserSettings SSR-seed byte-equality)', () => {
  it('returns the stored chat settings verbatim when present', () => {
    const stored = { muteSounds: true, replaceBadWords: false, acknowledged: true };
    // Identity: a present value passes through unchanged (resolver returns the
    // same object), so seed and resolver agree for any stored shape.
    expect(resolveChatSettings(stored)).toEqual(stored);
    expect(resolveChatSettings(stored)).toBe(stored);
  });

  it('substitutes the documented default when chat settings are absent', () => {
    // This is the exact object the OLD inline resolver default produced:
    //   { muteSounds: false, replaceBadWords: false, acknowledged: false }
    // Both the resolver and the SSR seed now route through this helper, so the
    // anon/no-settings path is identical on both sides.
    expect(resolveChatSettings(undefined)).toEqual({
      muteSounds: false,
      replaceBadWords: false,
      acknowledged: false,
    });
    expect(resolveChatSettings(undefined)).toBe(DEFAULT_CHAT_SETTINGS);
  });

  it('treats a partial stored object as-is (does not backfill missing keys)', () => {
    // Matches the resolver: a stored `{ muteSounds: true }` is returned as-is
    // (the schema fields are all optional). The seed must do the same.
    const partial = { muteSounds: true };
    expect(resolveChatSettings(partial)).toEqual({ muteSounds: true });
  });
});
