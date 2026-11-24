import { describe, expect, it } from 'vitest';
import { MAX_VIDEO_SECONDS } from '../../../../apps/event-engine/src/vector-sync/videos/limits';
import { MAX_INDEXED_VIDEO_SECONDS } from '~/shared/constants/video-length.constants';

// The event-engine cannot import src, so the site keeps its own copy of the embed limit.
describe('the video length presets', () => {
  it("top out at the embed worker's clip limit", () => {
    expect(MAX_INDEXED_VIDEO_SECONDS).toBe(MAX_VIDEO_SECONDS);
  });
});
