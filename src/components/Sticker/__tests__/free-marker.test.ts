import { describe, expect, it } from 'vitest';
import { freeMarkerVisible } from '~/components/Sticker/free-marker';

const OWNER = 1;
const PLACER = 2;
const STRANGER = 3;

const placement = { free: true, isPending: true, ownerId: OWNER, placerId: PLACER };

describe('freeMarkerVisible', () => {
  it('shows the owner that a sticker on their image was free', () => {
    expect(freeMarkerVisible({ ...placement, viewerId: OWNER })).toBe(true);
  });

  it('shows the placer their own free placement', () => {
    expect(freeMarkerVisible({ ...placement, viewerId: PLACER })).toBe(true);
  });

  it('shows a moderator, who already sees the free fact in the takedown copy', () => {
    expect(freeMarkerVisible({ ...placement, viewerId: STRANGER, isModerator: true })).toBe(true);
  });

  /**
   * The assertion that decays silently. The positive cases break loudly the
   * moment anyone touches the overlay; this one only breaks when someone widens
   * the gate, which is the change nobody flags. How a placement was funded is
   * private between the two parties to it.
   */
  it('tells a third-party viewer nothing about how the placement was funded', () => {
    expect(freeMarkerVisible({ ...placement, viewerId: STRANGER })).toBe(false);
  });

  it('tells a signed-out viewer nothing either', () => {
    expect(freeMarkerVisible({ ...placement, viewerId: undefined })).toBe(false);
  });

  /**
   * `viewerId` is `undefined` when signed out and the ids are real numbers, so a
   * loose comparison anywhere in this chain would hand every anonymous viewer
   * the marker on every free placement.
   */
  it('does not treat a missing viewer as a match for a falsy id', () => {
    expect(
      freeMarkerVisible({
        free: true,
        isPending: true,
        ownerId: 0,
        placerId: 0,
        viewerId: undefined,
      })
    ).toBe(false);
  });

  /**
   * The mark belongs to the decision, not to the sticker. Once the owner has
   * approved it, it is on the image on its own terms and nothing marks how it
   * was funded — including for the owner, who already answered that question.
   */
  it('says nothing once the placement is approved', () => {
    expect(freeMarkerVisible({ ...placement, isPending: false, viewerId: OWNER })).toBe(false);
    expect(freeMarkerVisible({ ...placement, isPending: false, viewerId: PLACER })).toBe(false);
    expect(
      freeMarkerVisible({ ...placement, isPending: false, viewerId: STRANGER, isModerator: true })
    ).toBe(false);
  });

  it('says nothing on a paid placement, to anyone', () => {
    expect(freeMarkerVisible({ ...placement, free: false, viewerId: OWNER })).toBe(false);
    expect(
      freeMarkerVisible({ ...placement, free: false, viewerId: STRANGER, isModerator: true })
    ).toBe(false);
  });
});
