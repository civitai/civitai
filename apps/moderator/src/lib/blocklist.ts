// FIXED order — this is the tab order, not an alphabetical sort; changing it moves tabs under
// people. (Blocklist.type is a plain string column — no shared DB enum to import.)
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

// Shared by both phrase lists — the same caveat in two literals drifts. Not on the profanity
// list, which matches whole words and so has no gap.
const PHRASE_GAP_RULE =
  ' A phrase only counts as whitelisted when its words are separated by spacing or punctuation.' +
  ' If anything else sits between them, the phrase is treated as not whitelisted for that' +
  ' occurrence, deliberately, so text cannot be hidden inside a whitelisted phrase. When that' +
  ' happens the flag you see may name the phrase itself.';

export const BLOCKLIST_DESCRIPTIONS: Partial<Record<BlocklistType, string>> = {
  EmailDomain:
    'Disposable-email domains blocked at signup. 🔴 A weekly job re-syncs this list from the' +
    ' upstream disposable-email-domains project, and it re-adds anything it still carries. So' +
    ' removing a domain that is on the upstream list holds until the next Sunday run and then' +
    ' silently comes back. Removing one the upstream list does not carry is permanent.',
  MessagePattern:
    'Case-insensitive substrings matched against chat messages and comments. A chat message that' +
    ' contains one is REFUSED; a comment is accepted and reported instead — it lands in the report' +
    ' queue as an automated report naming the pattern, and the author is told nothing, so a spam run' +
    ' cannot use the error to find out which words to change.',
  PromptBenignPhrase:
    'Whole phrases in the positive prompt that innocently contain a minor/POI detection word (proper nouns, technical terms). Each phrase is blanked from the prompt before the scan audit runs, so it never false-flags an image for review. Enter the full phrase — e.g. "teen titans", "minor barrel distortion".' + PHRASE_GAP_RULE,
  NegativeBenignPhrase:
    'Same as Prompt Benign Phrase, but matched against the negative prompt — e.g. "mature content". Use for boilerplate negatives that trip the minor audit.' + PHRASE_GAP_RULE,
  ProfanityBenignWord:
    'Single words that innocently contain a profanity token — "spreadsheet" contains "spread", "cockpit" contains "cock". The whole word is exempted from the profanity filter. One word per entry, not a phrase. This list REPLACES the one shipped with the site (it was seeded from it), so removing an entry here really does remove it. Applies to search; the generation gate still uses the shipped list.',
};
