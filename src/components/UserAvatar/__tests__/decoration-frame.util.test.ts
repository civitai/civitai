import { describe, expect, it } from 'vitest';
import { decorationFrameBox } from '~/components/UserAvatar/decoration-frame.util';

// The og share card draws the frame in pixels, so it must land where `decorationFrameStyle` puts it
// on the site: the same percentages, resolved against the avatar size.
describe('decorationFrameBox', () => {
  it('grows a legacy uniform offset around the centre', () => {
    // 200, not 100: at 100 a percentage and a pixel count are the same number.
    expect(decorationFrameBox(200, { offset: '30%' })).toEqual({
      left: -30,
      top: -30,
      width: 260,
      height: 260,
    });
  });

  it('scales per-side offsets from the 96px authoring size', () => {
    // Every side different, so a swapped side or axis lands somewhere else.
    expect(
      decorationFrameBox(192, { offsets: { top: -12, right: -6, bottom: -24, left: -3 } })
    ).toEqual({ left: -6, top: -24, width: 210, height: 264 });
  });

  it('grows a pixel offset by that many pixels, as `calc(100% + 12px)` does', () => {
    expect(decorationFrameBox(92, { offset: '12px' })).toEqual({
      left: -6,
      top: -6,
      width: 104,
      height: 104,
    });
  });

  it('matches the avatar box with no offset, or one it cannot read', () => {
    const avatar = { left: 0, top: 0, width: 92, height: 92 };
    expect(decorationFrameBox(92, {})).toEqual(avatar);
    expect(decorationFrameBox(92, { offset: 'auto' })).toEqual(avatar);
  });
});
