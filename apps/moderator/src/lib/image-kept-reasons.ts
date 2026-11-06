/** Why a moderator delete kept an image. Kept apart for the log; the moderator is never told which hold. */
export type ImageKeptReason = 'evidence' | 'review' | 'account';

export type KeptImage = { id: number; reason: ImageKeptReason };

const leftAsItWas = 'Kept: under review hold. Left as it was, so it may still be visible';

export const imageKeptReasonLabel: Record<ImageKeptReason, string> = {
  evidence: 'Kept: under review hold, and taken off the site',
  review: leftAsItWas,
  account: leftAsItWas,
};
