import { useEffect, useMemo } from 'react';
import { useSyncExternalStore } from 'react';
import type { ProfanityFilterOptions } from '~/libs/profanity-simple';
import {
  getProfanityFilter,
  setProfanityList,
  subscribeProfanity,
  type ProfanityListKind,
} from '~/libs/profanity-simple/runtime';
import { trpc } from '~/utils/trpc';

export type { ProfanityListKind };

export interface UseCheckProfanityOptions extends Partial<ProfanityFilterOptions> {
  /** Whether to enable profanity checking. When false, returns clean results */
  enabled?: boolean;
  /** Which dynamic list to use. Defaults to 'display'. */
  kind?: ProfanityListKind;
}

export interface ProfanityAnalysis {
  hasProfanity: boolean;
  matches: string[];
  matchedWords: string[];
  matchCount: number;
  cleanedText: string;
  originalText: string;
  /** True until the dynamic list has loaded and the filter is ready. */
  isLoading: boolean;
}

const emptyAnalysis = (text: string, isLoading: boolean): ProfanityAnalysis => ({
  hasProfanity: false,
  matches: [],
  matchedWords: [],
  matchCount: 0,
  cleanedText: text,
  originalText: text,
  isLoading,
});

/**
 * Subscribe to the profanity filter singleton, firing a deduped fetch of the
 * KV-backed list when `enabled`. Returns `{ filter, isLoading }`. While
 * `isLoading` is true the filter is `null` and consumers should not render
 * filter-dependent content (no bootstrap fallback on the client).
 */
export function useProfanityFilter(kind: ProfanityListKind, enabled = true) {
  const snapshot = () => getProfanityFilter(kind);
  const serverSnapshot = () => null;
  const filter = useSyncExternalStore(subscribeProfanity, snapshot, serverSnapshot);

  const { data } = trpc.system.getProfanityLists.useQuery(undefined, {
    enabled,
    staleTime: 1000 * 60 * 5,
    cacheTime: 1000 * 60 * 60 * 24,
  });

  useEffect(() => {
    if (!data) return;
    setProfanityList('display', data.display);
    setProfanityList('search', data.search);
  }, [data]);

  return { filter, isLoading: enabled && filter === null };
}

export function useCheckProfanity(
  text: string,
  options: UseCheckProfanityOptions = {}
): ProfanityAnalysis {
  const { enabled = true, kind = 'display' } = options;
  const { filter, isLoading } = useProfanityFilter(kind, enabled);

  return useMemo((): ProfanityAnalysis => {
    if (!enabled || !text.trim()) return emptyAnalysis(text, false);
    if (!filter) return emptyAnalysis(text, isLoading);

    try {
      const detailedAnalysis = filter.analyze(text);
      const cleanedText = filter.clean(text);

      return {
        hasProfanity: detailedAnalysis.isProfane,
        matches: detailedAnalysis.matches,
        matchedWords: detailedAnalysis.matchedWords,
        matchCount: detailedAnalysis.matchCount,
        cleanedText,
        originalText: text,
        isLoading: false,
      };
    } catch (error) {
      console.warn('Profanity analysis failed:', error);
      return emptyAnalysis(text, false);
    }
  }, [text, enabled, filter, isLoading]);
}

export function useIsProfane(text: string, options: UseCheckProfanityOptions = {}): boolean {
  return useCheckProfanity(text, options).hasProfanity;
}

export function useCleanText(text: string, options: UseCheckProfanityOptions = {}): string {
  return useCheckProfanity(text, options).cleanedText;
}
