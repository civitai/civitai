import { useMemo } from 'react';
import { createProfanityFilter, type ProfanityFilterOptions } from '~/libs/profanity-simple';
import { trpc } from '~/utils/trpc';

export type ProfanityListKind = 'display' | 'search';

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
 * Pulls the configured word list (display or search) from the system tRPC
 * endpoint so the lists can be updated via the KeyValue store without a
 * redeploy. Until the list resolves, analysis returns a passthrough result.
 */
export function useCheckProfanity(
  text: string,
  options: UseCheckProfanityOptions = {}
): ProfanityAnalysis {
  const { enabled = true, kind = 'display', replacementStyle } = options;

  const { data } = trpc.system.getProfanityLists.useQuery(undefined, {
    enabled,
    staleTime: 1000 * 60 * 60,
    cacheTime: 1000 * 60 * 60 * 24,
  });

  const profanityFilter = useMemo(() => {
    if (!data) return null;
    return createProfanityFilter({ blockedWords: data[kind], replacementStyle });
  }, [data, kind, replacementStyle]);

  return useMemo((): ProfanityAnalysis => {
    if (!enabled || !text.trim() || !profanityFilter) {
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
