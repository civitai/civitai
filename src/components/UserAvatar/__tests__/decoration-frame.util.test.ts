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
    expect(
      decorationFrameBox(192, { offsets: { top: -12, right: -6, bottom: 0, left: -6 } })
    ).toEqual({ left: -12, top: -24, width: 216, height: 216 });
  });

  it('matches the avatar box with no offset, or one it cannot read', () => {
    const avatar = { left: 0, top: 0, width: 92, height: 92 };
    expect(decorationFrameBox(92, {})).toEqual(avatar);
    expect(decorationFrameBox(92, { offset: '12px' })).toEqual(avatar);
  });
});
