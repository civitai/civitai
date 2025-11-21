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
  DataSet,
  asteriskCensorStrategy,
  grawlixCensorStrategy,
  assignIncrementingIds,
  pattern,
  resolveConfusablesTransformer,
  toAsciiLowerCaseTransformer,
  collapseDuplicatesTransformer,
  englishRecommendedWhitelistMatcherTransformers,
} from 'obscenity';

import { getCachedNsfwWords } from './word-processor';
import { customLeetSpeakTransformer } from './custom-transformers';
import whitelistWords from '~/utils/metadata/lists/whitelist-words.json';
import { removeTags } from '~/utils/string-helpers';
import { NsfwLevel } from '~/server/common/enums';
import { constants } from '~/server/common/constants';

export interface ProfanityFilterOptions {
  /** How to replace profane words */
  replacementStyle: 'asterisk' | 'grawlix' | 'remove';
}

export interface ProfanityThresholdConfig {
  /** Word count threshold for considering content as "short" */
  shortContentWordLimit: number;
  /** Number of profane matches required to mark short content as NSFW */
  shortContentMatchThreshold: number;
  /** Profanity density threshold (0-1) for long content to mark as NSFW */
  longContentDensityThreshold: number;
  /** Number of unique profane words that trigger NSFW regardless of density */
  diversityThreshold: number;
}

export interface ProfanityEvaluation {
  /** Whether the content should be marked as NSFW */
  shouldMarkNSFW: boolean;
  /** Explanation of why the decision was made */
  reason: string;
  /** Recommended NSFW level if content should be marked */
  suggestedLevel: NsfwLevel;
  /** Metrics used in the evaluation */
  metrics: {
    /** Total number of profane matches found */
    matchCount: number;
    /** Number of unique profane words */
    uniqueWords: number;
    /** Total word count in the content */
    totalWords: number;
    /** Profanity density (matchCount / totalWords) */
    density: number;
  };
  /** Array of actual matched words containing profanity (for admin/moderator review) */
  matchedWords?: string[];
}

/**
 * Create mappings between whitelist words and profane substrings they contain
 * Optimized to avoid repeated toLowerCase() calls
 */
function createWhitelistMappings(
  profaneWords: string[],
  whitelist: string[]
): Map<string, string[]> {
  const mappings = new Map<string, string[]>();

  // Preprocess whitelist to lowercase once for efficiency
  const lowerWhitelist = whitelist.map((word) => ({
    original: word,
    lower: word.toLowerCase(),
  }));

  // For each profane word, find whitelist words that contain it as a substring
  profaneWords.forEach((profaneWord) => {
    const lowerProfane = profaneWord.toLowerCase();

    const matchingWhitelistWords = lowerWhitelist
      .filter(({ lower }) => lower.includes(lowerProfane) && lower !== lowerProfane)
      .map(({ original }) => original);

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
  private readonly nsfwWords: ReturnType<typeof getCachedNsfwWords>;
  private readonly whitelistSet: Set<string>;

  constructor(options: Partial<ProfanityFilterOptions> = {}) {
    this.options = {
      replacementStyle: 'asterisk',
      ...options,
    };

    // Cache NSFW words once during construction
    this.nsfwWords = getCachedNsfwWords();

    // Initialize dataset with default English dictionary
    this.dataset = new DataSet();
    this.dataset.addAll(englishDataset);

    // Initialize whitelist mappings
    this.whitelistMappings = createWhitelistMappings(this.nsfwWords.originalWords, whitelistWords);

    // Initialize whitelist Set for O(1) lookup during analysis
    this.whitelistSet = new Set(whitelistWords.map((word) => word.toLowerCase()));

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

    if (matches.length === 0) {
      return {
        isProfane: false,
        matchCount: 0,
        matches: [],
        matchedWords: [],
      };
    }

    // Filter out matches where the full word is in the whitelist
    const filteredMatches = matches.filter((match) => {
      const { startIndex, endIndex } = this.dataset.getPayloadWithPhraseMetadata(match);
      const fullWord = this.extractFullWord(text, startIndex, endIndex + 1);
      return !this.isWhitelistedWord(fullWord);
    });

    // If all matches were filtered out, return clean result
    if (filteredMatches.length === 0) {
      return {
        isProfane: false,
        matchCount: 0,
        matches: [],
        matchedWords: [],
      };
    }

    // Efficiently extract unique original words and full words in single pass
    const uniqueWords = new Set<string>();
    const matchedWordsSet = new Set<string>();

    filteredMatches.forEach((match) => {
      const { phraseMetadata, startIndex, endIndex } =
        this.dataset.getPayloadWithPhraseMetadata(match);
      const originalWord = phraseMetadata?.originalWord;
      if (originalWord) {
        uniqueWords.add(originalWord);
      }

      // Extract the full word that contains the profane text
      // Fix: getPayloadWithPhraseMetadata returns endIndex that's 1 less than it should be
      const fullWord = this.extractFullWord(text, startIndex, endIndex + 1);

      // Add the full word context
      if (fullWord.trim()) {
        matchedWordsSet.add(fullWord);
      }
    });

    return {
      isProfane: true,
      matchCount: filteredMatches.length,
      matches: Array.from(uniqueWords),
      matchedWords: Array.from(matchedWordsSet),
    };
  }

  /**
   * Evaluate content for NSFW classification based on profanity thresholds
   * Strips HTML before analysis and applies intelligent threshold logic
   */
  evaluateContent(
    text: string,
    config: Partial<ProfanityThresholdConfig> = {}
  ): ProfanityEvaluation {
    const finalConfig = { ...constants.profanity.thresholds, ...config };

    // Strip HTML tags to get plain text
    const plainText = removeTags(text);
    // Analyze the plain text
    const analysis = this.analyze(plainText);

    // If no profanity detected, return early
    if (!analysis.isProfane) {
      return {
        shouldMarkNSFW: false,
        reason: 'No profanity detected',
        suggestedLevel: NsfwLevel.PG,
        metrics: {
          matchCount: 0,
          uniqueWords: 0,
          totalWords: this.countWords(plainText),
          density: 0,
        },
        matchedWords: [],
      };
    }

    // Calculate metrics
    const totalWords = this.countWords(plainText);
    const density = totalWords > 0 ? analysis.matchCount / totalWords : 0;
    const uniqueWords = analysis.matches.length;

    // Threshold 1: High diversity of profane words
    if (uniqueWords >= finalConfig.diversityThreshold) {
      return {
        shouldMarkNSFW: true,
        reason: `High diversity of profanity (${uniqueWords} unique profane words)`,
        suggestedLevel: NsfwLevel.R,
        metrics: {
          matchCount: analysis.matchCount,
          uniqueWords,
          totalWords,
          density,
        },
        matchedWords: analysis.matchedWords,
      };
    }

    // Threshold 2: Long content with high density
    if (totalWords >= finalConfig.shortContentWordLimit) {
      if (density >= finalConfig.longContentDensityThreshold) {
        return {
          shouldMarkNSFW: true,
          reason: `High profanity density (${(density * 100).toFixed(2)}% in ${totalWords} words)`,
          suggestedLevel: NsfwLevel.R,
          metrics: {
            matchCount: analysis.matchCount,
            uniqueWords,
            totalWords,
            density,
          },
          matchedWords: analysis.matchedWords,
        };
      }
    } else {
      // Threshold 3: Short content with multiple matches
      if (analysis.matchCount >= finalConfig.shortContentMatchThreshold) {
        return {
          shouldMarkNSFW: true,
          reason: `Multiple profane words in short content (${analysis.matchCount} matches in ${totalWords} words)`,
          suggestedLevel: NsfwLevel.PG13,
          metrics: {
            matchCount: analysis.matchCount,
            uniqueWords,
            totalWords,
            density,
          },
          matchedWords: analysis.matchedWords,
        };
      }
    }

    // Profanity within acceptable limits
    return {
      shouldMarkNSFW: false,
      reason: `Profanity within acceptable limits (${analysis.matchCount} matches, ${(
        density * 100
      ).toFixed(2)}% density)`,
      suggestedLevel: NsfwLevel.PG,
      metrics: {
        matchCount: analysis.matchCount,
        uniqueWords,
        totalWords,
        density,
      },
      matchedWords: analysis.matchedWords,
    };
  }

  /**
   * Check if a word is in the whitelist (case-insensitive)
   */
  private isWhitelistedWord(word: string): boolean {
    return this.whitelistSet.has(word.toLowerCase().trim());
  }

  /**
   * Count words in plain text
   * Handles whitespace and filters out empty strings
   */
  private countWords(text: string): number {
    return text
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 0).length;
  }

  /**
   * Extract the full word that contains the profane substring
   */
  private extractFullWord(text: string, matchStart: number, matchEnd: number): string {
    // Find word boundaries - look for whitespace, punctuation, or string boundaries
    const wordBoundaryRegex = /[\s\W]/;

    // Find start of word (go backwards from match start)
    let wordStart = matchStart;
    while (wordStart > 0 && !wordBoundaryRegex.test(text[wordStart - 1])) {
      wordStart--;
    }

    // Find end of word (go forwards from match end)
    let wordEnd = matchEnd;
    while (wordEnd < text.length && !wordBoundaryRegex.test(text[wordEnd])) {
      wordEnd++;
    }

    return text.substring(wordStart, wordEnd);
  }

  private initializeMatcher(): void {
    // Always add extended words from metadata
    this.dataset = this.extendWithCustomDataset(this.dataset);

    // Build the matcher with custom transformers to avoid false positives
    // Note: We use a custom leetspeak transformer instead of the default one
    // because the default maps '(' to 'c', causing false positives like
    // "(untucked)" being detected as profanity.
    const builtDataset = this.dataset.build();
    this.matcher = new RegExpMatcher({
      ...builtDataset,
      blacklistMatcherTransformers: [
        resolveConfusablesTransformer(), // '🅰' => 'a' (Unicode confusables)
        customLeetSpeakTransformer, // Custom leetspeak without problematic punctuation
        toAsciiLowerCaseTransformer(), // Case insensitive matching
        collapseDuplicatesTransformer({
          customThresholds: new Map([
            ['b', 2], // a_bb_o
            ['e', 2], // ab_ee_d
            ['o', 2], // b_oo_nga
            ['l', 2], // fe_ll_atio
            ['s', 2], // a_ss_
            ['g', 2], // ni_gg_er
          ]),
        }), // 'aaaa' => 'a'
      ],
      whitelistMatcherTransformers: englishRecommendedWhitelistMatcherTransformers,
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
    // Use the cached NSFW words to avoid repeated calls
    const wordsToAdd = this.nsfwWords.originalWords; // includes both original words only for now
    const filteredWords = wordsToAdd.filter((word) => word.length >= 3); // Filter out very short words

    // Early return if no words to add
    if (filteredWords.length === 0) {
      return dataset;
    }

    const patterns = assignIncrementingIds(filteredWords.map((word) => pattern`${word}`));

    // Add words to dataset with their whitelisted terms
    patterns.forEach((p, index) => {
      const word = filteredWords[index];
      const whitelistTerms = this.whitelistMappings.get(word) || [];

      const phrase = dataset.addPhrase((phrase) => {
        let phraseBuilder = phrase
          .setMetadata({ originalWord: word.replace(/\|/g, '') })
          .addPattern(p.pattern);

        // Add whitelisted terms to this phrase (optimize for common case of no terms)
        if (whitelistTerms.length > 0) {
          whitelistTerms.forEach((whitelistedTerm) => {
            phraseBuilder = phraseBuilder.addWhitelistedTerm(whitelistedTerm);
          });
        }

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
