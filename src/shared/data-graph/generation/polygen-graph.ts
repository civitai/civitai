/**
 * PolyGen Graph
 *
 * Minimal placeholder graph for the PolyGen (Meshy via Fal) ecosystem.
 *
 * Why empty: the 3D Models workflows (`txt2model3d`, `img2model3d`) render the
 * standalone `Model3DGenerationForm` as a self-contained workflow body — same
 * dispatch pattern as `img2meta` and `prompt:enhance` (see GenerationForm.tsx).
 * That form is RHF-bound to `model3dGenerationSchema` and calls the dedicated
 * `trpc.orchestrator.generate3D` / `generate3DWhatIf` procedures directly,
 * bypassing the unified `generateFromGraph` pipeline.
 *
 * This graph only exists to satisfy the `ecosystemGraph` discriminator
 * requirement that every registered ecosystem value maps to a branch, and so
 * the workflow→ecosystem registry / picker stays consistent with the audio /
 * image / video ecosystems.
 *
 * Mirrors the shape of `metadataExtractionGraph` (which performs the same role
 * for the `img2meta` self-contained workflow).
 */

import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';

/** Context shape for polygen graph (mirrors ace-audio-graph for parity). */
type PolyGenCtx = { ecosystem: string; workflow: string };

export const polyGenGraph = new DataGraph<PolyGenCtx, GenerationCtx>();

export type PolyGenGraphCtx = ReturnType<typeof polyGenGraph.init>;
