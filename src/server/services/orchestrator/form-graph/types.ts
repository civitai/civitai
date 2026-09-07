import type { InferArm, InferData, InferLooseData } from 'form-graph';
import type { generationHub } from '~/shared/form-graph/generation/hub.graph';

/**
 * Types for the form-graph handler lane. Handlers consume `parse().data` —
 * the WIRE shape, differentially pinned against the data-graph oracle — so a
 * handler here receives exactly what its data-graph counterpart receives.
 */

/** The composed root's parsed wire data — a union over every family arm. */
export type GenerationData = InferData<typeof generationHub>;

/**
 * The arms the ECOSYSTEM dispatcher serves — the root union minus the
 * standalone workflow arms (upscale/interpolate/remove-background/…), whose
 * step creation lives in the submit service, keyed on the workflow.
 */
export type EcosystemGenerationData = Extract<GenerationData, { ecosystem: string }>;

/**
 * One (or several) family arms, selected by the ecosystem discriminant — the
 * hub tables type every arm's ecosystem as a literal, so this is the typed
 * view a handler declares instead of narrowing a loose bag by hand.
 */
export type EcosystemData<E extends EcosystemGenerationData['ecosystem']> = InferArm<
  typeof generationHub,
  'ecosystem',
  E
>;

/**
 * Every key of every arm, optional — for helpers shared across arms, which
 * read fields defensively (a field a family lacks is simply absent).
 */
export type LooseGenerationData = InferLooseData<typeof generationHub>;

/**
 * The comfy-style loras map every handler builds from additional resources.
 * One home for the AIR resolution and the `?? 1` strength default.
 */
export function resourcesToLoras(
  resources: { id: number; strength?: number }[] | undefined,
  airs: { getOrThrow: (id: number) => string }
): Record<string, number> | undefined {
  if (!resources?.length) return undefined;
  const loras: Record<string, number> = {};
  for (const resource of resources) {
    loras[airs.getOrThrow(resource.id)] = resource.strength ?? 1;
  }
  return loras;
}
