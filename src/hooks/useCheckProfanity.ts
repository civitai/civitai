import { useMemo } from 'react';
import type { ProfanityFilterOptions } from '~/libs/profanity-simple';
import { useProfanityFilter, type ProfanityListKind } from '~/providers/ProfanityListsProvider';

export type { ProfanityListKind };

export interface UseCheckProfanityOptions extends Partial<ProfanityFilterOptions> {
  /** Whether to enable profanity checking. When false, returns clean results */
  enabled?: boolean;
  /** Which dynamic list to use. Defaults to 'display'. */
  kind?: ProfanityListKind;
}

export interface ProfanityAnalysis {
  /** Whether the text contains profane words */
  hasProfanity: boolean;
  /** Array of matched profane words/phrases from dataset */
  matches: string[];
  /** Array of full words from input that contain profanity */
  matchedWords: string[];
  /** Number of profane matches found */
  matchCount: number;
  /** Text with profane words replaced */
  cleanedText: string;
  /** Original text */
  originalText: string;
}

const EMPTY_ANALYSIS = (text: string): ProfanityAnalysis => ({
  hasProfanity: false,
  matches: [],
  matchedWords: [],
  matchCount: 0,
  cleanedText: text,
  originalText: text,
});

/**
 * Hook to check text for profanity and return analysis results.
 *
 * Pulls the filter from `ProfanityListsProvider`, which boots from the bundled
 * lists synchronously and swaps to the KV-backed list once the system query
 * resolves. No per-call-site filter construction.
 */
export function useCheckProfanity(
  text: string,
  options: UseCheckProfanityOptions = {}
): ProfanityAnalysis {
  const { enabled = true, kind = 'display' } = options;
  const profanityFilter = useProfanityFilter(kind);

  return useMemo((): ProfanityAnalysis => {
    if (!enabled || !text.trim()) {
      return EMPTY_ANALYSIS(text);
    }

    try {
      const detailedAnalysis = profanityFilter.analyze(text);
      const cleanedText = profanityFilter.clean(text);

      return {
        hasProfanity: detailedAnalysis.isProfane,
        matches: detailedAnalysis.matches,
        matchedWords: detailedAnalysis.matchedWords,
        matchCount: detailedAnalysis.matchCount,
        cleanedText,
        originalText: text,
      };
    } catch (error) {
      console.warn('Profanity analysis failed:', error);
      return EMPTY_ANALYSIS(text);
    }
  }, [text, enabled, profanityFilter]);
}

/**
 * Hook variant that only returns whether text contains profanity.
 */
export function useIsProfane(text: string, options: UseCheckProfanityOptions = {}): boolean {
  const { hasProfanity } = useCheckProfanity(text, options);
  return hasProfanity;
}

/**
 * Hook variant that only returns cleaned text.
 */
export function useCleanText(text: string, options: UseCheckProfanityOptions = {}): string {
  const { cleanedText } = useCheckProfanity(text, options);
  return cleanedText;
}
