import { defineGraph } from 'form-graph';
import { SEED, boolDef, imagesDef } from '../defs';
import { familyScope, type FamilyExt } from '../shared';

/**
 * Pixal3D and Trellis.2, ported from `pixal3d-graph.ts` / `trellis2-graph.ts`.
 * The two v1 graphs are field-for-field identical (Trellis.2 is the base
 * modelVersion of the pipeline Pixal3D rides), so one factory serves both —
 * each ecosystem still gets its own graph instance for its own family scope.
 */

const trellisPipelineGraph = () =>
  defineGraph<FamilyExt>({ scope: familyScope })
    .field('images', imagesDef({ min: 1, max: 1 }))
    .field('shouldTexture', boolDef(true))
    .field('shouldRemesh', boolDef(true))
    .field('enablePbr', boolDef(false))
    .field('seed', SEED);

export const pixal3d = trellisPipelineGraph();
export const trellis2 = trellisPipelineGraph();
