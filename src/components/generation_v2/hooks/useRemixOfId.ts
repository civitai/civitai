/**
 * useRemixOfId Hook
 *
 * Calculates prompt similarity between current prompt and the original remix source.
 * Returns remixOfId only if prompt similarity is >= 75%, otherwise returns undefined.
 *
 * This prevents images that have deviated significantly from the original
 * from being marked as remixes.
 */

import { useMemo } from 'react';
import { useRemixStore } from '~/store/remix.store';
import { useGraph } from '~/libs/data-graph/react';
import type { GenerationGraphTypes } from '~/shared/data-graph/generation';
import { promptSimilarity } from '~/utils/prompt-similarity';

/**
 * Hook to get remixOfId if current prompt is similar enough to the original.
 *
 * @returns remixOfId if prompt similarity >= 75%, otherwise undefined
 */
export function useRemixOfId(): number | undefined {
  const graph = useGraph<GenerationGraphTypes>();
  const remixData = useRemixStore((state) => state.data);

  return useMemo(() => {
    // No remix data means this isn't a remix
    if (!remixData) return undefined;

    // Get current and original prompts
    const snapshot = graph.getSnapshot() as Record<string, unknown>;
    const currentPrompt = (snapshot.prompt as string) ?? '';
    const originalPrompt = (remixData.originalParams.prompt as string) ?? '';

    // Calculate prompt similarity
    const { similar } = promptSimilarity(currentPrompt, originalPrompt);

    // Return remixOfId only if prompt is similar enough
    return similar ? remixData.remixOfId : undefined;
  }, [graph, remixData]);
}

/**
 * Hook to get the current prompt similarity score (for display purposes).
 *
 * @returns similarity info or null if not a remix
 */
export function useRemixSimilarity(): {
  cosine: number;
  containment: number;
  adjustedCosine: number;
  similar: boolean;
} | null {
  const graph = useGraph<GenerationGraphTypes>();
  const remixData = useRemixStore((state) => state.data);

  return useMemo(() => {
    if (!remixData) return null;

    const snapshot = graph.getSnapshot() as Record<string, unknown>;
    const currentPrompt = (snapshot.prompt as string) ?? '';
    const originalPrompt = (remixData.originalParams.prompt as string) ?? '';

    return promptSimilarity(currentPrompt, originalPrompt);
  }, [graph, remixData]);
}
