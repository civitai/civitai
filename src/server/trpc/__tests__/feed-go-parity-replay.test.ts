/**
 * The feed-go serve-side parity replay marker (`~/server/trpc/feed-go-parity-replay`). Its name is
 * a wire contract with feed-go (`ParityReplayHeader`, `X-Feed-Go-Parity-Replay`, which Node reads
 * lowercased), so it is a literal here. What the marker changes is pinned where it acts: the
 * shadow sampler's "does not sample" cases (feed-go-shadow.test.ts) and the write format
 * (src/server/__tests__/trpc-response-write-format.test.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  FEED_GO_PARITY_REPLAY_HEADER,
  isFeedGoParityReplay,
} from '~/server/trpc/feed-go-parity-replay';

describe('feed-go parity replay marker', () => {
  it('is the lowercased wire name feed-go sends', () => {
    expect(FEED_GO_PARITY_REPLAY_HEADER).toBe('x-feed-go-parity-replay');
  });

  it.each([
    [{ 'x-feed-go-parity-replay': '1' }, true],
    [{ 'x-feed-go-parity-replay': '' }, true],
    [{ 'x-feed-go-parity-replay': ['1', '1'] }, true],
    [{ host: 'civitai.com' }, false],
    [{}, false],
    [undefined, false],
    [null, false],
  ])('reads %j as a replay: %s', (headers, want) => {
    expect(isFeedGoParityReplay(headers)).toBe(want);
  });
});
