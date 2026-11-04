import { NsfwLevel } from '@civitai/shared';
import type { MediaType } from '$lib/media/edge-url';

export type ComFaceCover = { id: number; url: string; type: MediaType; nsfwLevel: number };

/** A model's civitai.com face: its `.com` title and cover, and the model's page on civitai.com.
 *  `coverPicked` with no `cover` means the picked image is gone. */
export type ComFace = {
  name: string;
  url: string;
  cover: ComFaceCover | null;
  coverPicked: boolean;
};

/** civitai.com shows nothing above PG-13, and passes over an unrated image on a mature model, so a
 *  face cover outside PG to PG-13 is not what civitai.com shows. */
export const isComSafeLevel = (nsfwLevel: number) => nsfwLevel > 0 && nsfwLevel <= NsfwLevel.PG13;
