import { describe, expect, it } from 'vitest';
import { getVideoUrls } from '../edge-url';

const VIDEO = 'b9eb4fcf-a45a-4960-b6de-1c7b412d824a';

describe('getVideoUrls poster', () => {
  it('asks the CDN for a transcoded still frame of the video', () => {
    const { poster } = getVideoUrls(VIDEO, { width: 450 });
    expect(poster).toContain('anim=false');
    expect(poster).toContain('transcode=true');
    expect(poster).toContain('width=450');
  });

  it('uses a given thumbnail image as is', () => {
    const { poster } = getVideoUrls(VIDEO, { width: 450 }, 'thumb-image-uuid');
    expect(poster).toContain('thumb-image-uuid');
    expect(poster).not.toContain('transcode=true');
  });
});
