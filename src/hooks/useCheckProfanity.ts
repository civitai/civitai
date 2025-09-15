import { useMemo } from 'react';
import { createProfanityFilter, type ProfanityFilterOptions } from '~/libs/profanity-simple';

export interface UseCheckProfanityOptions extends Partial<ProfanityFilterOptions> {
  /** Whether to enable profanity checking. When false, returns clean results */
  enabled?: boolean;
}

export interface ProfanityAnalysis {
  /** Whether the text contains profane words */
  hasProfanity: boolean;
  /** Array of matched profane words/phrases */
  matches: string[];
  /** Text with profane words replaced */
  cleanedText: string;
  /** Original text */
  originalText: string;
}

/**
 * Hook to check text for profanity and return analysis results
 *
 * @param text - The text to analyze
 * @param options - Configuration options for profanity filtering
 * @returns Analysis results including profanity status, matches, and cleaned text
 *
 * @example
 * ```tsx
 * const { hasProfanity, matches, cleanedText } = useCheckProfanity(
 *   userInput,
 *   { enabled: true, replacementStyle: 'asterisk' }
 * );
 *
 * if (hasProfanity) {
 *   console.log('Found profanity:', matches);
 *   console.log('Cleaned text:', cleanedText);
 * }
 * ```
 */
export function useCheckProfanity(
  text: string,
  options: UseCheckProfanityOptions = {}
): ProfanityAnalysis {
  const { enabled = true } = options;

  // Create profanity filter with provided options
  const profanityFilter = useMemo(() => {
    return createProfanityFilter();
  }, []);

  // Analyze the text
  const analysis = useMemo((): ProfanityAnalysis => {
    // Return clean results if disabled or if global blur is off
    if (!enabled || !text.trim()) {
      return {
        hasProfanity: false,
        matches: [],
        cleanedText: text,
        originalText: text,
      };
    }

    try {
      // Get detailed analysis from the profanity filter
      const detailedAnalysis = profanityFilter.analyze(text);
      const cleanedText = profanityFilter.clean(text);

      // Extract matched words from analysis
      const matches = detailedAnalysis.matches;

      return {
        hasProfanity: detailedAnalysis.isProfane,
        matches,
        cleanedText,
        originalText: text,
      };
    } catch (error) {
      console.warn('Profanity analysis failed:', error);
      // Return safe defaults if analysis fails
      return {
        hasProfanity: false,
        matches: [],
        cleanedText: text,
        originalText: text,
      };
    }
  }, [text, enabled, profanityFilter]);

  return analysis;
}

/**
 * Hook variant that only returns whether text contains profanity
 * Useful for simple validation scenarios
 *
 * @param text - The text to check
 * @param options - Configuration options
 * @returns Boolean indicating if text contains profanity
 *
 * @example
 * ```tsx
 * const isProfane = useIsProfane(searchQuery);
 * if (isProfane) {
 *   setError('Please use appropriate language');
 * }
 * ```
 */
export function useIsProfane(text: string, options: UseCheckProfanityOptions = {}): boolean {
  const { hasProfanity } = useCheckProfanity(text, options);
  return hasProfanity;
}

/**
 * Hook variant that only returns cleaned text
 * Useful when you just need the sanitized version
 *
 * @param text - The text to clean
 * @param options - Configuration options
 * @returns Cleaned text with profanity replaced
 *
 * @example
 * ```tsx
 * const cleanText = useCleanText(userComment);
 * ```
 */
export function useCleanText(text: string, options: UseCheckProfanityOptions = {}): string {
  const { cleanedText } = useCheckProfanity(text, options);
  return cleanedText;
}
