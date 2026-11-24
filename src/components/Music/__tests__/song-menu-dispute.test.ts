import { describe, expect, it } from 'vitest';
import { canDisputeSongRating } from '~/components/Music/SongContextMenu';

// The song menu's "Dispute rating" (Music T10 S7): the owner's, behind both dispute and music flags,
// and only on a song its own scans have reviewed, the one a moderator may rule on.
const flags = { ratingDispute: true, music: true };

describe('the song menu’s Dispute rating', () => {
  it('shows for the owner of a reviewed song, and of one whose state the card does not carry', () => {
    expect(canDisputeSongRating({ isOwner: true, features: flags, ingestion: 'Scanned' })).toBe(
      true
    );
    expect(canDisputeSongRating({ isOwner: true, features: flags })).toBe(true);
  });

  it('hides for a listener, without either flag, and on a song still being reviewed', () => {
    expect(canDisputeSongRating({ isOwner: false, features: flags, ingestion: 'Scanned' })).toBe(
      false
    );
    expect(canDisputeSongRating({ isOwner: true, features: { ...flags, music: false } })).toBe(
      false
    );
    expect(
      canDisputeSongRating({ isOwner: true, features: { ...flags, ratingDispute: false } })
    ).toBe(false);
    expect(canDisputeSongRating({ isOwner: true, features: flags, ingestion: 'Pending' })).toBe(
      false
    );
  });
});
