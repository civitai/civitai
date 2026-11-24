import type { AppealCoverImage } from '$lib/server/minor-hash.service';
import type { CsamHoldItem } from '$lib/server/csam-holds.service';

/** What a `UserProfile` hold's account shows the world. Images are captioned tiles: avatar, cover, SFW cover. */
export type HoldProfile = {
  bio: string | null;
  message: string | null;
  sfwBio: string | null;
  sfwMessage: string | null;
  location: string | null;
  images: AppealCoverImage[];
};

/** What a comment hangs off. `type` is the thread target (`post`, `model`, `image`, `article`, ...). */
export type HoldParent = {
  type: string;
  id: number;
  title: string | null;
  images: AppealCoverImage[];
  imageTotal: number;
};

/** A `TrackLyrics` hold's song, for the player; null when gone or withheld from this moderator. */
export type HoldSong = { id: number; url: string };

export type HoldContext = {
  profile: HoldProfile | null;
  parent: HoldParent | null;
  song: HoldSong | null;
  /** The song exists but is withheld from this moderator (`withheldImageIds`). */
  songWithheld: boolean;
  /** Reading the song or its withheld check failed: no url, and not the same as a song that is gone. */
  songUnavailable: boolean;
};

export type CsamHoldView = CsamHoldItem & HoldContext;

const PARENT_LABELS: Record<string, string> = {
  bountyEntry: 'bounty entry',
};

export const parentLabel = (type: string) => PARENT_LABELS[type] ?? type;

/** `entityUrl`'s key for a thread target, which names a review differently. */
export const parentUrlType = (type: string) => (type === 'review' ? 'resourcereview' : type);
