// Client-safe term lists for highlighting scanner-audit content. They aid the moderator's eye only —
// they do NOT drive policy (that's the XGuard registry + scanner-label-regex). Per label:
//   trigger  — terms the policy fires on (red)
//   soft     — carve-out terms that fire when stacked (amber)
//   carveOut — terms arguing against firing (green)

export type HighlightCategory = 'trigger' | 'soft' | 'carveOut';

export type LabelHighlightTerms = Record<HighlightCategory, string[]>;

export const SCANNER_LABEL_HIGHLIGHT_TERMS: Record<string, LabelHighlightTerms> = {
  young: {
    trigger: [
      // English youth nouns
      'child', 'children', 'kid', 'kids', 'toddler', 'baby', 'infant',
      'minor', 'minors', 'underage',
      'loli', 'lolicon', 'shota', 'cub', 'cunny',
      'schoolgirl', 'schoolboy', 'schoolgirls', 'schoolboys',
      'elementary student', 'kindergartner', 'preschooler',
      'aged down', 'age regression', 'age-regressed',
      // Age qualifiers
      'teen', 'teens', 'teenage', 'teenager', 'teenagers',
      'preteen', 'pre-teen', 'tween',
      // "Young/little + child noun"
      'little girl', 'little boy', 'little child', 'little kid',
      'young son', 'young daughter', 'young child', 'young kid',
      // Body-as-child
      'toddler body', 'baby body', 'infant body',
      // Foreign-language youth terms (common ones seen in mod data)
      'học sinh', 'девочка', '学生', '女子高生', '少女', 'ロリ', '여학생',
      // Family child-framing
      'mom and son', 'father and daughter', 'mother and son', 'dad and daughter',
    ],
    soft: [
      // Single 'young' (without child noun) — frequent evasion signal
      'young',
      // Body-archetype descriptors that have carve-outs but stack into evasion
      'petite', 'shortstack', 'small frame', 'cute face',
      'small body', 'tiny body', 'slim', 'slender', 'delicate',
      'smooth skin', 'soft features',
      'innocent', 'naive', 'shy', 'pure',
      'chibi', 'chibi proportions',
      // Generic person tags that contribute to stacking
      '1girl', '1boy', '2girls', '2boys',
      'girl', 'boy',
    ],
    carveOut: [
      // Adult-anchor terms
      'adult', 'mature', 'milf', 'gilf', 'elderly', 'old woman', 'old man',
      'cougar', 'voluptuous adult', 'mature female',
      // Adult-vocabulary 'young X' phrases
      'young woman', 'young man', 'young female', 'young lady',
      'young actor', 'young model', 'young athlete', 'young professional',
      'young couple', 'young college girl',
      // Explicit adult ages
      '18+', '18', '19', '20', '21', '22', '23', '24', '25',
      '26', '27', '28', '29', '30',
      'in her 20s', 'in his 20s', 'in her 30s', 'in his 30s',
      'early twenties', 'late teens', '20-something', 'thirtysomething',
    ],
  },
  // Add more labels here as the moderator team requests them. The renderer falls back to plain
  // model-reason highlighting when a label isn't keyed.
};

export function getLabelHighlightTerms(
  label: string
): Array<{ term: string; category: HighlightCategory }> {
  const entry = SCANNER_LABEL_HIGHLIGHT_TERMS[label.toLowerCase()];
  if (!entry) return [];
  const out: Array<{ term: string; category: HighlightCategory }> = [];
  for (const category of ['trigger', 'soft', 'carveOut'] as const) {
    for (const term of entry[category]) out.push({ term, category });
  }
  return out;
}
