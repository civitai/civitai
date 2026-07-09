// Policy constants for public (user-created) challenges. Kept in shared/ so both the
// server (validation/enforcement) and the client (form limits, previews) use one source.

/** Minimum User.meta.scores.total required to create a challenge (the existing
 * "high-reputation" tier — see post.schema.ts rate-limit rules). */
export const CHALLENGE_MIN_CREATOR_SCORE = 5000;

/** Buzz taken from each paid entry to cover AI judging + platform overhead. */
export const CHALLENGE_ENTRY_HOUSE_CUT = 25;

/** Minimum entry fee. Must exceed the house cut so at least
 * (CHALLENGE_MIN_ENTRY_FEE - CHALLENGE_ENTRY_HOUSE_CUT) buzz reaches the prize pool. */
export const CHALLENGE_MIN_ENTRY_FEE = 50;

/** Upper bound on entry fee (sanity ceiling; not a product limit). */
export const CHALLENGE_MAX_ENTRY_FEE = 100_000;

/** Upper bound on the creator's optional initial prize (escrowed at creation). */
export const CHALLENGE_MAX_INITIAL_PRIZE = 10_000_000;

/** Max simultaneously Scheduled+Active user-created challenges, by membership tier.
 * (fib: free 1, bronze 2, silver 3, gold 5; founder treated as bronze.) */
export const CHALLENGE_TIER_ACTIVE_LIMITS: Record<string, number> = {
  free: 1,
  founder: 2,
  bronze: 2,
  silver: 3,
  gold: 5,
};

export const CHALLENGE_DEFAULT_ACTIVE_LIMIT = 1;

export function getChallengeActiveLimit(tier?: string | null): number {
  if (!tier) return CHALLENGE_DEFAULT_ACTIVE_LIMIT;
  return CHALLENGE_TIER_ACTIVE_LIMITS[tier] ?? CHALLENGE_DEFAULT_ACTIVE_LIMIT;
}

/** Net buzz a single paid entry contributes to the prize pool (never negative). */
export function getEntryPoolContribution(entryFee: number): number {
  return Math.max(0, entryFee - CHALLENGE_ENTRY_HOUSE_CUT);
}

// The label a category is scored under becomes a JSON key in the AI review schema; it must be
// stable across the write, the AI prompt, and the ranking lookup. Normalize once at write time.
export const sanitizeCategoryLabel = (s: string) => s.replace(/"/g, "'").replace(/\s+/g, ' ').trim();

// Vibe groups the judging categories are organized into (used for the grouped picker in the form).
export const CHALLENGE_CATEGORY_GROUPS = [
  'Universal',
  'Horror / Dark',
  'Comedy / Playful',
  'Cute / Wholesome',
  'Beauty / Glamour',
  'Sci-Fi / Fantasy',
  'Action / Drama',
] as const;
export type ChallengeCategoryGroup = (typeof CHALLENGE_CATEGORY_GROUPS)[number];

// Curated judging categories a public-challenge creator can weight. `theme` is mandatory (schema
// refine) and its gate always applies. `criteria` is the scoring instruction injected into the AI
// judge per selected category — the server derives label + criteria from the key, so the client can
// never inject its own criteria text. Keep criteria free of double quotes (they become JSON keys/
// comments in the review schema; the sanitizer collapses quotes/whitespace anyway).
export const CHALLENGE_PRESET_CATEGORIES = {
  theme: { label: 'Theme', group: 'Universal', criteria: 'How well the entry fits and interprets the challenge theme; higher for a clear, strong, on-theme interpretation.' },
  creativity: { label: 'Creativity', group: 'Universal', criteria: 'Originality and inventiveness of the concept; higher for fresh, unexpected takes over clichés.' },
  aesthetic: { label: 'Aesthetic', group: 'Universal', criteria: 'Overall visual appeal — composition, color, lighting, and style; higher for striking, well-composed images.' },
  technical: { label: 'Technical Quality', group: 'Universal', criteria: 'Rendering correctness — coherent anatomy and objects, clean detail, minimal artifacts or distortions.' },
  emotion: { label: 'Emotional Impact', group: 'Universal', criteria: 'Mood and atmosphere; higher for images that strongly evoke a feeling.' },
  storytelling: { label: 'Storytelling', group: 'Universal', criteria: 'How well the image conveys a narrative or sense of scene; higher for a clear, compelling story.' },
  gruesomeness: { label: 'Gruesomeness', group: 'Horror / Dark', criteria: 'How visceral and gory the imagery is; higher for convincingly grisly, unsettling detail.' },
  dread: { label: 'Dread', group: 'Horror / Dark', criteria: 'Tension, unease, and a sense of impending danger; higher for a strong sense of dread.' },
  creepiness: { label: 'Creepiness', group: 'Horror / Dark', criteria: 'How eerie or disturbing the entry feels; higher for genuinely unnerving results.' },
  shock: { label: 'Shock Value', group: 'Horror / Dark', criteria: 'Boldness and impact; higher for provocatively surprising imagery.' },
  humor: { label: 'Humor', group: 'Comedy / Playful', criteria: 'How funny or amusing the entry is; higher for genuinely funny results.' },
  wittiness: { label: 'Wittiness', group: 'Comedy / Playful', criteria: 'Cleverness and conceptual wit of the idea; higher for sharp, clever concepts.' },
  absurdity: { label: 'Absurdity', group: 'Comedy / Playful', criteria: 'Surreal, ridiculous invention; higher for wonderfully absurd ideas.' },
  cuteness: { label: 'Cuteness', group: 'Cute / Wholesome', criteria: 'How adorable or endearing the subject is; higher for irresistibly cute results.' },
  charm: { label: 'Charm', group: 'Cute / Wholesome', criteria: 'Overall charm and likeability; higher for warm, appealing entries.' },
  wholesomeness: { label: 'Wholesomeness', group: 'Cute / Wholesome', criteria: 'How heartwarming or wholesome the mood is; higher for uplifting, feel-good images.' },
  elegance: { label: 'Elegance', group: 'Beauty / Glamour', criteria: 'Grace and refinement of the composition and subject; higher for elegant, polished results.' },
  sensuality: { label: 'Sensuality', group: 'Beauty / Glamour', criteria: 'Tasteful, confident allure; higher for compellingly sensual imagery.' },
  glamour: { label: 'Glamour', group: 'Beauty / Glamour', criteria: 'Glamour and style; higher for striking, fashionable presentation.' },
  futurism: { label: 'Futurism', group: 'Sci-Fi / Fantasy', criteria: 'How convincingly futuristic or high-tech the vision is; higher for imaginative, believable future tech.' },
  worldbuilding: { label: 'Worldbuilding', group: 'Sci-Fi / Fantasy', criteria: 'Depth and coherence of the world or setting; higher for rich, immersive environments.' },
  epicness: { label: 'Epicness', group: 'Sci-Fi / Fantasy', criteria: 'Scale and grandeur; higher for sweeping, awe-inspiring imagery.' },
  detail: { label: 'Detail', group: 'Sci-Fi / Fantasy', criteria: 'Richness and density of meaningful detail; higher for intricate, rewarding-to-explore images.' },
  dynamism: { label: 'Dynamism', group: 'Action / Drama', criteria: 'Sense of motion and energy; higher for dynamic, kinetic compositions.' },
  intensity: { label: 'Intensity', group: 'Action / Drama', criteria: 'Emotional or dramatic intensity; higher for gripping, high-stakes imagery.' },
  cinematics: { label: 'Cinematics', group: 'Action / Drama', criteria: 'Cinematic quality — lighting, framing, and mood like a film still; higher for cinematic results.' },
} as const satisfies Record<string, { label: string; group: ChallengeCategoryGroup; criteria: string }>;

export type ChallengeCategoryKey = keyof typeof CHALLENGE_PRESET_CATEGORIES;
export const CHALLENGE_CATEGORY_KEYS = Object.keys(CHALLENGE_PRESET_CATEGORIES) as [
  ChallengeCategoryKey,
  ...ChallengeCategoryKey[]
];

// Shape of one judging-category row in the creator form (RHF field-array item). label + criteria are
// display-only copies of the preset — the server re-derives them from `key` at write time.
export type CategoryWeightRow = {
  key: ChallengeCategoryKey;
  label: string;
  criteria: string;
  weight: number;
};

// Theme + up to 3 more.
export const MAX_CATEGORIES = 4;

// Presets a non-Theme row may pick; Theme is reserved for the always-present first row.
export const ADDABLE_PRESET_KEYS = CHALLENGE_CATEGORY_KEYS.filter((key) => key !== 'theme');

export function makeRow(key: ChallengeCategoryKey): CategoryWeightRow {
  const preset = CHALLENGE_PRESET_CATEGORIES[key];
  return { key, label: preset.label, criteria: preset.criteria, weight: 0 };
}

// Default starting categories mirror the daily rubric split (theme 50 / wittiness 15 / humor 15 /
// aesthetic 20 = 100) so a creator has a sensible default without configuring anything. Theme stays
// first + non-removable; the other three are freely editable or removable. Seeded into the form's
// defaultValues so useFieldArray starts populated with no seeding effect.
export const DEFAULT_CATEGORY_ROWS: CategoryWeightRow[] = [
  { ...makeRow('theme'), weight: 50 },
  { ...makeRow('wittiness'), weight: 15 },
  { ...makeRow('humor'), weight: 15 },
  { ...makeRow('aesthetic'), weight: 20 },
];

// Judges a public-challenge creator may pick. Keyed on NAME (env-stable; excludes "CivChan NSFW",
// which shares CivChan's userId — public challenges are SFW-only).
export const USER_SELECTABLE_JUDGE_NAMES = ['CivBot', 'CivChan'] as const;
