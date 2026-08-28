/**
 * Trellis.2 Graph
 *
 * Controls for the Trellis.2 (via Comfy) 3D-model generation ecosystem.
 * Trellis.2 is the base `modelVersion` of the same pipeline Pixal3D rides;
 * like Pixal3D / Tripo / Hunyuan3D it is image-to-3D only, so there is no
 * `process` discriminator. It rides the shared `img2model3d` workflow; the
 * active ecosystem is chosen via the `BaseModelInput` picker.
 *
 * The handler (`trellis2-graph.handler.ts`) consumes the validated snapshot and
 * emits a `PolyGenStepTemplate` matching `trellis2.schema.ts`. Every node name
 * matches a shared 3D Controller in `GenerationForm.tsx` (`images`,
 * `shouldTexture`, `shouldRemesh`, `enablePbr`, `seed`), so no Trellis.2-specific
 * form block is needed — those Controllers auto-show when the active ecosystem
 * is Trellis2 (same reuse pattern Pixal3D/Hunyuan3D use for their toggles).
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { imagesNode, seedNode } from './common';

// =============================================================================
// Trellis.2 Graph
// =============================================================================

type Trellis2Ctx = { ecosystem: string; workflow: string };

export const trellis2Graph = new DataGraph<Trellis2Ctx, GenerationCtx>()
  // Image-to-3D source — the standard `images` node (min/max 1), matching the
  // polygen graph's img2model3d convention. The handler reads `images[0]`.
  .node(
    'images',
    imagesNode({
      min: 1,
      max: 1,
      label: 'Starting image',
      description: 'The reference Trellis.2 will use to build the 3D mesh',
    })
  )
  .node('shouldTexture', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: true,
  })
  .node('shouldRemesh', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: true,
  })
  .node('enablePbr', {
    input: z.boolean().optional(),
    output: z.boolean(),
    defaultValue: false,
  })
  .node('seed', seedNode());

export type Trellis2GraphCtx = ReturnType<typeof trellis2Graph.init>;
