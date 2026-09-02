import type { generationHub } from '~/shared/form-graph/generation/hub.graph';

/**
 * Types for the form-graph handler lane. Handlers consume `parse().data` —
 * the WIRE shape, differentially pinned against the data-graph oracle — so a
 * handler here receives exactly what its data-graph counterpart receives.
 */

type ParseOk = Extract<ReturnType<typeof generationHub.parse>, { success: true }>;

/** The composed root's parsed wire data — a union over every family arm. */
export type GenerationData = ParseOk['data'];

type AllKeys<U> = U extends unknown ? keyof U : never;

/**
 * Every key of every arm, optional — the handler-side counterpart of the
 * graph bag's loose read. Handlers read fields defensively (a field a family
 * lacks is simply absent), which this types directly instead of the v1
 * pattern of `'field' in data` narrowing on a discriminated union.
 */
export type Loose<U> = {
  [K in AllKeys<U>]?: U extends unknown ? (K extends keyof U ? U[K] : never) : never;
};

export type LooseGenerationData = Loose<GenerationData>;
