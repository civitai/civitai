/**
 * Simple Profanity Filter - Focused implementation using obscenity + compromise
 *
 * This is a streamlined profanity detection system that:
 * - Uses obscenity package for core profanity detection (includes leetspeak handling)
 * - Uses compromise to generate word variations (plurals, conjugations)
 * - Extends word dictionary with metadata words
 * - Provides synchronous operations for React components
 */

import {
  RegExpMatcher,
  TextCensor,
  englishDataset,
  englishRecommendedTransformers,
  DataSet,
  asteriskCensorStrategy,
  grawlixCensorStrategy,
  assignIncrementingIds,
  pattern,
} from 'obscenity';

import { getCachedNsfwWords } from './word-processor';
import { isDefined } from '~/utils/type-guards';
import whitelistWords from '~/utils/metadata/lists/whitelist-words.json';

export interface ProfanityFilterOptions {
  /** How to replace profane words */
  replacementStyle: 'asterisk' | 'grawlix' | 'remove';
}

const MIN_WORD_LENGTH = 3; // Minimum length of words to include in filter

/**
 * Create mappings between whitelist words and profane substrings they contain
 */
function createWhitelistMappings(
  profaneWords: string[],
  whitelist: string[]
): Map<string, string[]> {
  const mappings = new Map<string, string[]>();

  // For each profane word, find whitelist words that contain it as a substring
  profaneWords.forEach((profaneWord) => {
    const matchingWhitelistWords = whitelist.filter(
      (whitelistWord) =>
        whitelistWord.toLowerCase().includes(profaneWord.toLowerCase()) &&
        whitelistWord.toLowerCase() !== profaneWord.toLowerCase() // Don't map exact matches
    );

    if (matchingWhitelistWords.length > 0) {
      mappings.set(profaneWord, matchingWhitelistWords);
    }
  });

  return mappings;
}

export class SimpleProfanityFilter {
  private matcher!: RegExpMatcher;
  private censor!: TextCensor;
  private options: ProfanityFilterOptions;
  private dataset: DataSet<{ originalWord: string }>;
  private whitelistMappings: Map<string, string[]>;

  constructor(options: Partial<ProfanityFilterOptions> = {}) {
    this.options = {
      replacementStyle: 'asterisk',
      ...options,
    };

    // Initialize dataset with default English dictionary
    this.dataset = new DataSet();
    this.dataset.addAll(englishDataset);

    // Initialize whitelist mappings
    const nsfwWords = getCachedNsfwWords();
    this.whitelistMappings = createWhitelistMappings(nsfwWords.originalWords, whitelistWords);

    this.initializeMatcher();
    this.initializeCensor();
  }

  /**
   * Check if text contains profanity
   */
  isProfane(text: string): boolean {
    return this.matcher.hasMatch(text);
  }

  /**
   * Check if text contains profanity (alias for isProfane)
   */
  hasMatch(text: string): boolean {
    return this.matcher.hasMatch(text);
  }

  /**
   * Clean profane words from text
   */
  clean(text: string): string {
    const matches = this.matcher.getAllMatches(text);
    return this.censor.applyTo(text, matches);
  }

  /**
   * Get detailed information about matches
   */
  analyze(text: string) {
    const matches = this.matcher.getAllMatches(text, true); // sorted by position
    return {
      isProfane: matches.length > 0,
      matchCount: matches.length,
      matches: Array.from(
        new Set(
          matches
            .map((match) => {
              return this.dataset.getPayloadWithPhraseMetadata(match);
            })
            .map((payload) => payload.phraseMetadata?.originalWord)
            .filter(isDefined)
        )
      ),
    };
  }

  private initializeMatcher(): void {
    // Always add extended words from metadata
    this.dataset = this.extendWithCustomDataset(this.dataset);

    // Build the matcher
    const builtDataset = this.dataset.build();
    this.matcher = new RegExpMatcher({
      ...builtDataset,
      ...englishRecommendedTransformers, // Includes leetspeak handling
    });
  }

  private initializeCensor(): void {
    this.censor = new TextCensor();

    // Set replacement strategy - we use custom logic in cleanWithCustomLogic instead
    switch (this.options.replacementStyle) {
      case 'asterisk':
        this.censor.setStrategy(asteriskCensorStrategy());
        break;
      case 'grawlix':
        this.censor.setStrategy(grawlixCensorStrategy());
        break;
      case 'remove':
        this.censor.setStrategy(() => ''); // Remove completely
        break;
    }
  }

  private extendWithCustomDataset(
    dataset: DataSet<{ originalWord: string }>
  ): DataSet<{ originalWord: string }> {
    // Use the existing word processor that handles regex cleaning, deduplication,
    // and word variations from all metadata lists
    const nsfwWords = getCachedNsfwWords();
    const wordsToAdd = nsfwWords.allWords; // includes both original + generated variations

    // Filter out very short words to prevent false positives like "Uber" -> "U**r"
    // Words shorter than 3 characters can cause unwanted substring matches
    const filteredWords = wordsToAdd.filter((word) => word.length >= MIN_WORD_LENGTH);

    const patterns = assignIncrementingIds(
      filteredWords.map((word) =>
        // If word is short, add boundary to prevent substring matches
        word.length <= MIN_WORD_LENGTH ? pattern`|${word}` : pattern`${word}`
      )
    );

    // Add words to dataset with their whitelisted terms
    patterns.forEach((p, index) => {
      const word = filteredWords[index];
      const whitelistTerms = this.whitelistMappings.get(word) || [];

      const phrase = dataset.addPhrase((phrase) => {
        let phraseBuilder = phrase.setMetadata({ originalWord: word }).addPattern(p.pattern);

        // Add whitelisted terms to this phrase
        whitelistTerms.forEach((whitelistedTerm) => {
          phraseBuilder = phraseBuilder.addWhitelistedTerm(whitelistedTerm);
        });

        return phraseBuilder;
      });

      dataset = phrase;
    });

    return dataset;
  }

  /**
   * Update the filter options and rebuild
   */
  updateOptions(newOptions: Partial<ProfanityFilterOptions>): void {
    this.options = { ...this.options, ...newOptions };
    this.initializeCensor(); // Only need to reinitialize censor since matcher doesn't use these options
  }
}

// Factory function for easy use
export function createProfanityFilter(
  options?: Partial<ProfanityFilterOptions>
): SimpleProfanityFilter {
  return new SimpleProfanityFilter(options);
}
