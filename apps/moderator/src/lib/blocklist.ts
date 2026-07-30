// Sorted for stable tabs. (Blocklist.type is a plain string column — no shared DB enum to import.)
export const BLOCKLIST_TYPES = [
  'EmailDomain',
  'LinkDomain',
  'MessagePattern',
  'UsernameExact',
  'UsernamePartial',
  'PromptBenignPhrase',
  'NegativeBenignPhrase',
] as const;

export type BlocklistType = (typeof BLOCKLIST_TYPES)[number];

export const humanizeBlocklistType = (t: string) => t.replace(/([a-z])([A-Z])/g, '$1 $2');

export const BLOCKLIST_DESCRIPTIONS: Partial<Record<BlocklistType, string>> = {
  PromptBenignPhrase:
    'Whole phrases in the positive prompt that innocently contain a minor/POI detection word (proper nouns, technical terms). Each phrase is blanked from the prompt before the scan audit runs, so it never false-flags an image for review. Enter the full phrase — e.g. "teen titans", "minor barrel distortion".',
  NegativeBenignPhrase:
    'Same as Prompt Benign Phrase, but matched against the negative prompt — e.g. "mature content". Use for boilerplate negatives that trip the minor audit.',
};
