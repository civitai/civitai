// Sorted for stable tabs. (Blocklist.type is a plain string column — no shared DB enum to import.)
export const BLOCKLIST_TYPES = [
  'EmailDomain',
  'LinkDomain',
  'MessagePattern',
  'UsernameExact',
  'UsernamePartial',
  'PromptBenignPhrase',
  'NegativeBenignPhrase',
  'ProfanityBenignWord',
] as const;

export type BlocklistType = (typeof BLOCKLIST_TYPES)[number];

export const humanizeBlocklistType = (t: string) => t.replace(/([a-z])([A-Z])/g, '$1 $2');

export const BLOCKLIST_DESCRIPTIONS: Partial<Record<BlocklistType, string>> = {
  PromptBenignPhrase:
    'Whole phrases in the positive prompt that innocently contain a minor/POI detection word (proper nouns, technical terms). Each phrase is blanked from the prompt before the scan audit runs, so it never false-flags an image for review. Enter the full phrase — e.g. "teen titans", "minor barrel distortion". A phrase only counts as whitelisted when its words are separated by spacing or punctuation. If anything else sits between them, the phrase is treated as not whitelisted for that occurrence, deliberately, so text cannot be hidden inside a whitelisted phrase. When that happens the flag you see may name the phrase itself.',
  NegativeBenignPhrase:
    'Same as Prompt Benign Phrase, but matched against the negative prompt — e.g. "mature content". Use for boilerplate negatives that trip the minor audit. A phrase only counts as whitelisted when its words are separated by spacing or punctuation. If anything else sits between them, the phrase is treated as not whitelisted for that occurrence, deliberately, so text cannot be hidden inside a whitelisted phrase. When that happens the flag you see may name the phrase itself.',
  ProfanityBenignWord:
    'Single words that innocently contain a profanity token — "spreadsheet" contains "spread", "cockpit" contains "cock". The whole word is exempted from the profanity filter. One word per entry, not a phrase; it is matched whole, so it has no gap and the phrase rule above does not apply. This list REPLACES the one shipped with the site (it was seeded from it), so removing an entry here really does remove it. Applies to search; the generation gate still uses the shipped list.',
};
