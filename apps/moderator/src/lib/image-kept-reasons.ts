/** Why a moderator delete kept an image: its child-safety case. */
export type ImageKeptReason = 'review';

export type KeptImage = { id: number; reason: ImageKeptReason };
