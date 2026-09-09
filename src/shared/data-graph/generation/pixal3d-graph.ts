/**
 * Pixal3D Graph
 *
 * Controls for the Pixal3D (via Comfy / Trellis2) 3D-model generation
 * ecosystem. Pixal3D is image-to-3D only, so — like Tripo and Hunyuan3D and
 * unlike PolyGen (Meshy) — there is no `process` discriminator. It rides the
 * shared `img2model3d` workflow; the active ecosystem is chosen via the
 * `BaseModelInput` picker.
 *
 * The handler (`pixal3d-graph.handler.ts`) consumes the validated snapshot and
 * emits a `PolyGenStepTemplate` matching `pixal3d.schema.ts`. Every node name
 * matches a shared 3D Controller in `GenerationForm.tsx` (`images`,
 * `shouldTexture`, `shouldRemesh`, `enablePbr`, `seed`), so no Pixal3D-specific
 * form block is needed — those Controllers auto-show when the active ecosystem
 * is Pixal3D (same reuse pattern Hunyuan3D uses for its toggles).
 */

import z from 'zod';
import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';
import { imagesNode, seedNode } from './common';

// =============================================================================
// Pixal3D Graph
// =============================================================================

type Pixal3dCtx = { ecosystem: string; workflow: string };

export const pixal3dGraph = new DataGraph<Pixal3dCtx, GenerationCtx>()
  // Image-to-3D source — the standard `images` node (min/max 1), matching the
  // polygen graph's img2model3d convention. The handler reads `images[0]`.
  .node(
    'images',
    imagesNode({
      min: 1,
      max: 1,
      label: 'Starting image',
      description: 'The reference Pixal3D will use to build the 3D mesh',
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

export type Pixal3dGraphCtx = ReturnType<typeof pixal3dGraph.init>;
