/**
 * Metadata Extraction Graph
 *
 * Empty graph for the img2meta workflow.
 * This workflow doesn't use the graph system — the UI is fully self-contained
 * in MetadataExtractionPanel. This graph only exists to satisfy the
 * groupedDiscriminator requirement that every workflow value maps to a branch.
 */

import { DataGraph } from '~/libs/data-graph/data-graph';
import type { GenerationCtx } from './context';

export const metadataExtractionGraph = new DataGraph<Record<never, never>, GenerationCtx>();

export type MetadataExtractionGraphCtx = ReturnType<typeof metadataExtractionGraph.init>;
