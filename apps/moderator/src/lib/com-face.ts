import { NsfwLevel } from '@civitai/shared';
import type { MediaType } from '$lib/media/edge-url';

export type ComFaceCover = { id: number; url: string; type: MediaType; nsfwLevel: number };

/** A model's civitai.com face: its `.com` title and cover, and the model's page on civitai.com. */
export type ComFace = { name: string; url: string; cover: ComFaceCover | null };

/** civitai.com shows nothing above PG-13, so a face cover rated higher is itself wrong. */
export const isComSafeLevel = (nsfwLevel: number) => nsfwLevel <= NsfwLevel.PG13;
