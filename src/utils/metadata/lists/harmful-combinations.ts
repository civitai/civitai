export interface HarmfulCombination {
  pattern: RegExp;
  type: 'minor' | 'poi';
}

// Harmful word combinations that should be blocked
export const harmfulCombinations: HarmfulCombination[] = [
  // Child-related harmful combinations with verb conjugations
  { pattern: /child[\s\W]*abus(?:e|es|ed|ing)/i, type: 'minor' },
  { pattern: /child[\s\W]*harm(?:s|ed|ing)?/i, type: 'minor' },
  { pattern: /child[\s\W]*violen(?:ce|t)/i, type: 'minor' },
  { pattern: /child[\s\W]*exploit(?:ation|ing|ed|s)?/i, type: 'minor' },
  { pattern: /child[\s\W]*assault(?:s|ed|ing)?/i, type: 'minor' },
  { pattern: /child[\s\W]*attack(?:s|ed|ing)?/i, type: 'minor' },
  { pattern: /child[\s\W]*hurt(?:s|ing)?/i, type: 'minor' },
  { pattern: /child[\s\W]*damag(?:e|es|ed|ing)/i, type: 'minor' },
  { pattern: /child[\s\W]*molest(?:s|ed|ing|ation)?/i, type: 'minor' },

  // Minor-related harmful combinations with verb conjugations
  { pattern: /minor[\s\W]*abus(?:e|es|ed|ing)/i, type: 'minor' },
  { pattern: /minor[\s\W]*harm(?:s|ed|ing)?/i, type: 'minor' },
  { pattern: /minor[\s\W]*violen(?:ce|t)/i, type: 'minor' },
  { pattern: /minor[\s\W]*exploit(?:ation|ing|ed|s)?/i, type: 'minor' },
  { pattern: /minor[\s\W]*assault(?:s|ed|ing)?/i, type: 'minor' },
  { pattern: /minor[\s\W]*attack(?:s|ed|ing)?/i, type: 'minor' },
  { pattern: /minor[\s\W]*hurt(?:s|ing)?/i, type: 'minor' },
  { pattern: /minor[\s\W]*damag(?:e|es|ed|ing)/i, type: 'minor' },
  { pattern: /minor[\s\W]*molest(?:s|ed|ing|ation)?/i, type: 'minor' },

  // Underage-related harmful combinations with verb conjugations
  { pattern: /underage[\s\W]*abus(?:e|es|ed|ing)/i, type: 'minor' },
  { pattern: /underage[\s\W]*harm(?:s|ed|ing)?/i, type: 'minor' },
  { pattern: /underage[\s\W]*violen(?:ce|t)/i, type: 'minor' },
  { pattern: /underage[\s\W]*exploit(?:ation|ing|ed|s)?/i, type: 'minor' },
  { pattern: /underage[\s\W]*assault(?:s|ed|ing)?/i, type: 'minor' },
  { pattern: /underage[\s\W]*attack(?:s|ed|ing)?/i, type: 'minor' },
  { pattern: /underage[\s\W]*hurt(?:s|ing)?/i, type: 'minor' },
  { pattern: /underage[\s\W]*damag(?:e|es|ed|ing)/i, type: 'minor' },
  { pattern: /underage[\s\W]*molest(?:s|ed|ing|ation)?/i, type: 'minor' },

  // Age-specific harmful combinations with verb conjugations
  {
    pattern:
      /\b(?:1[0-7]|[1-9])[\s\W]*(?:year[\s\W]*old|y[\s\W]*o)[\s\W]*(?:abus(?:e|es|ed|ing)|harm(?:s|ed|ing)?|violen(?:ce|t)|exploit(?:ation|ing|ed|s)?|assault(?:s|ed|ing)?|attack(?:s|ed|ing)?|hurt(?:s|ing)?|damag(?:e|es|ed|ing)|molest(?:s|ed|ing|ation)?)/i,
    type: 'minor',
  },

  // General minor-related harmful terms with verb conjugations
  {
    pattern:
      /(?:teen|teenager|youth|juvenile|adolescent)[\s\W]*(?:abus(?:e|es|ed|ing)|harm(?:s|ed|ing)?|violen(?:ce|t)|exploit(?:ation|ing|ed|s)?|assault(?:s|ed|ing)?|attack(?:s|ed|ing)?|hurt(?:s|ing)?|damag(?:e|es|ed|ing)|molest(?:s|ed|ing|ation)?)/i,
    type: 'minor',
  },

  // Real person harmful combinations with verb conjugations
  {
    pattern:
      /(?:celebrity|famous[\s\W]*person|public[\s\W]*figure)[\s\W]*(?:abus(?:e|es|ed|ing)|harm(?:s|ed|ing)?|violen(?:ce|t)|exploit(?:ation|ing|ed|s)?|assault(?:s|ed|ing)?|attack(?:s|ed|ing)?|hurt(?:s|ing)?|damag(?:e|es|ed|ing)|molest(?:s|ed|ing|ation)?)/i,
    type: 'poi',
  },

  // Reverse patterns - harmful actions targeting children/minors
  { pattern: /abus(?:e|es|ed|ing)[\s\W]*(?:child|minor|underage)/i, type: 'minor' },
  { pattern: /harm(?:s|ed|ing)?[\s\W]*(?:child|minor|underage)/i, type: 'minor' },
  { pattern: /attack(?:s|ed|ing)?[\s\W]*(?:child|minor|underage)/i, type: 'minor' },
  { pattern: /hurt(?:s|ing)?[\s\W]*(?:child|minor|underage)/i, type: 'minor' },
  { pattern: /damag(?:e|es|ed|ing)[\s\W]*(?:child|minor|underage)/i, type: 'minor' },
  { pattern: /molest(?:s|ed|ing|ation)?[\s\W]*(?:child|minor|underage)/i, type: 'minor' },
  { pattern: /exploit(?:ation|ing|ed|s)?[\s\W]*(?:child|minor|underage)/i, type: 'minor' },

  // Age-specific reverse patterns
  {
    pattern:
      /(?:abus(?:e|es|ed|ing)|harm(?:s|ed|ing)?|violen(?:ce|t)|exploit(?:ation|ing|ed|s)?|assault(?:s|ed|ing)?|attack(?:s|ed|ing)?|hurt(?:s|ing)?|damag(?:e|es|ed|ing)|molest(?:s|ed|ing|ation)?)[\s\W]*\b(?:1[0-7]|[1-9])[\s\W]*(?:year[\s\W]*old|y[\s\W]*o)/i,
    type: 'minor',
  },
];
