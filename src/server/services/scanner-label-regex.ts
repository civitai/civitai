/**
 * Regex term lists for atomic scanner labels.
 *
 * Each entry is data-only — the consuming detector implementation lives
 * elsewhere. The structure is meant to be readable AND machine-consumable.
 *
 * Design rules:
 *   - `triggers`: plain whole-word terms. The consumer wraps each with a
 *     whole-word boundary like /(?<![a-z0-9])TERM(?![a-z0-9])/i so substrings
 *     don't false-match (e.g. "cub" should not match inside "incubus").
 *   - `phrasePatterns`: multi-word phrase patterns. Whitespace in the source
 *     should match `\s+` at consume time so weight syntax like "(young:1.4)"
 *     normalizes correctly.
 *   - `carveOutPatterns`: regex patterns (no delimiters) that match
 *     false-positive contexts. The consumer MATCHES-AND-STRIPS these from the
 *     prompt BEFORE looking for triggers. Order: strip carve-outs → look for
 *     triggers.
 *   - `pairPhraseConnectors`, `pluralImpliesPair`, `soloUnambiguous`,
 *     `possessivePronouns`: structured fields for Familial-style detection
 *     where the label requires a relation between two entities, not just one
 *     keyword. Other labels leave these undefined.
 *
 * All patterns are case-insensitive at consume time. Normalize prompts to
 * lowercase before matching (and strip weight syntax: "(term:1.4)" → "term").
 *
 * Multilingual coverage is intentionally NOT included here. Non-English
 * prompts should be routed to an LLM fallback per the tiered detection plan
 * in docs/features/scanner-label-architecture.md. Maintain this file only
 * for English vocabulary; LLM handles the rest.
 */

/**
 * Version stamp for the regex term lists. Bump whenever any of the per-label
 * specs change (terms added/removed, carve-outs updated). The version is
 * stored alongside each match in `scanner_regex_shadow_results` so audit
 * queries can correlate a change in agreement rate with a known version bump.
 *
 * Format: `regex-v<N>` where N is a monotonic integer. Don't reuse numbers.
 */
export const REGEX_VERSION = 'regex-v1';

export interface LabelRegexSpec {
  /** Plain whole-word terms. Each gets wrapped with whole-word boundaries. */
  triggers: string[];
  /** Multi-word phrase patterns (whitespace becomes \s+). */
  phrasePatterns?: string[];
  /** Regex patterns to strip from the prompt BEFORE trigger matching. */
  carveOutPatterns?: string[];
  /** Pair connectors for "X and Y" pair detection (Familial-style). */
  pairPhraseConnectors?: string[];
  /** Plural terms that ALONE imply a multi-person relationship. */
  pluralImpliesPair?: string[];
  /** Single terms that unambiguously imply a relation to another person. */
  soloUnambiguous?: string[];
  /** Possessive pronouns that pair with a relation noun ("her nephew"). */
  possessivePronouns?: string[];
  /** Human-readable notes on tricky cases. */
  notes?: string;
}

// ============================================================================
// FAMILIAL
// Fires when the prompt explicitly identifies a family or blood relationship
// BETWEEN two or more people. A single person tagged with a family role
// (e.g. "mommy aesthetic", "MILF") does NOT fire — Familial requires a pair.
// ============================================================================
export const FAMILIAL: LabelRegexSpec = {
  triggers: [
    // Parents
    'mother',
    'father',
    'mom',
    'dad',
    'mommy',
    'daddy',
    'momma',
    'poppa',
    'papa',
    'parent',
    'parents',
    // Children
    'son',
    'daughter',
    'sons',
    'daughters',
    'child',
    'children',
    'kid',
    'kids',
    // Siblings
    'brother',
    'sister',
    'brothers',
    'sisters',
    'sibling',
    'siblings',
    'bro',
    'sis',
    'twin',
    'twins',
    // Extended
    'aunt',
    'uncle',
    'cousin',
    'cousins',
    'niece',
    'nephew',
    'grandmother',
    'grandfather',
    'grandma',
    'grandpa',
    'granny',
    'gramps',
    'granddaughter',
    'grandson',
    'grandchild',
    'grandchildren',
    // Step-relatives
    'stepmom',
    'stepdad',
    'stepson',
    'stepdaughter',
    'stepsister',
    'stepbrother',
    'step-mom',
    'step-dad',
    'step-son',
    'step-daughter',
    'step-sister',
    'step-brother',
    'stepmother',
    'stepfather',
    'step-mother',
    'step-father',
    'stepfamily',
    // In-laws
    'mother-in-law',
    'father-in-law',
    'sister-in-law',
    'brother-in-law',
    'son-in-law',
    'daughter-in-law',
  ],
  pluralImpliesPair: [
    'sisters',
    'brothers',
    'siblings',
    'twins',
    'parents',
    'children',
    'kids',
    'sons',
    'daughters',
    'cousins',
    'grandchildren',
  ],
  soloUnambiguous: [
    // These imply a relation to another person by definition
    'nephew',
    'niece',
    'stepson',
    'stepdaughter',
    'step-son',
    'step-daughter',
    'stepmom',
    'stepdad',
    'step-mom',
    'step-dad',
    'stepmother',
    'stepfather',
    'step-mother',
    'step-father',
    'stepsister',
    'stepbrother',
    'step-sister',
    'step-brother',
    'granddaughter',
    'grandson',
    'grandchild',
  ],
  possessivePronouns: ['her', 'his', 'their', 'my', 'your', 'our'],
  pairPhraseConnectors: [
    'and',
    '&',
    'with',
    'seducing',
    'seduced by',
    'fucking',
    'sucking',
    'kissing',
    'loving',
    'touching',
    'holding',
    'hugging',
    'on top of',
    'beneath',
  ],
  carveOutPatterns: [
    // Religious
    'sister of the (convent|church|order|cross|sisterhood)',
    'sisters of the (convent|church|order|cross|sisterhood)',
    'brother(s)? of the (church|order|monastery|brotherhood)',
    '(holy|reverend) (mother|father|sister|brother)',
    '(mother|father) (superior|abbot|abbess)',
    // Military / oath idioms
    'brother(s)?[\\s-]in[\\s-]arm(s)?',
    'sister(s)?[\\s-]in[\\s-]arm(s)?',
    'soul sister',
    'soul brother',
    'sister(s)? in spirit',
    'blood brother(s)?', // sworn-brotherhood idiom
    // Mentor / archetype framing
    'father figure',
    'mother figure',
    'big[\\s-]sister[\\s-]type',
    'big[\\s-]brother[\\s-]type',
    'little[\\s-]sister[\\s-]type',
    'little[\\s-]brother[\\s-]type',
    '(older|elder|big|little) sister archetype',
    '(older|elder|big|little) brother archetype',
    'motherly (smile|figure|love|warmth|hug)',
    'fatherly (smile|figure|love|warmth|hug)',
    '(big|little) sister(s)? energy',
    '(big|little) brother(s)? energy',
    // Standalone roleplay archetypes (don't imply a paired family member)
    // Note: leaving "MILF", "DILF", "mommy", "daddy" as standalone terms in
    // the trigger list is fine because Familial requires 2+ family terms by
    // default. These solo-only cases will not fire unless paired.
  ],
  notes:
    'Familial requires a relationship between two people. A single family-role tag (mommy, MILF) without a paired family member does not fire — the detector should require 2+ distinct family terms, OR a plural-implies-pair, OR a solo-unambiguous term (nephew etc.), OR a possessive-pair phrase ("her sister"), OR a pair-phrase ("X and Y"). The MILF/DILF case is handled by the same arithmetic: "MILF" alone is one term, not two.',
};

// ============================================================================
// NON-CONSENT KEYWORD (atomic component)
// Detects literal non-consent terminology. Fires REGARDLESS of sexual context
// at the atomic level — the derivation rule (NC-keyword AND sexual) gates the
// final NonConsent label. Mods reviewing the keyword atom may see fires in
// non-sexual prompts too; the derived NonConsent label only fires when
// Suggestive or Explicit also fires.
// ============================================================================
export const NONCONSENT_KEYWORD: LabelRegexSpec = {
  triggers: [
    'rape',
    'raped',
    'raping',
    'rapes',
    'rapist',
    'noncon',
    'noncons',
    'molested',
    'molesting',
    'molestation',
    // Incapacitation terms — the derivation rule pairs these with sexual signal,
    // so they're safe at the atomic level. Without the AND-sexual gate they'd
    // over-fire on "passed out drunk", "asleep on couch" etc.
    'drugged',
    'comatose',
    'unconscious',
  ],
  phrasePatterns: [
    'non-consensual',
    'non consensual',
    'forced sex',
    'forced into sex',
    'forced to have sex',
    'sexual assault',
    'sexually assaulted',
    'assaulted sexually',
    'sex against will',
    'without consent',
    'against her will',
    'against his will',
    'against their will',
    // Incapacitation phrase patterns
    'passed out',
    'knocked out',
    'asleep and', // "asleep and being..." — biases toward NC framing
  ],
  carveOutPatterns: [
    // "forced" used in non-sexual senses
    'forced perspective',
    'forced into a corner',
    'forced to smile',
    'forced laughter',
    'forced expression',
    'forced into hiding',
    'forced into battle',
    'forced into combat',
    'forced into action',
    'forced march',
    'forced entry',
    // "drugged" in non-sexual contexts is hard to disambiguate via regex
    // alone; rely on the AND-sexual derivation rule to filter.
  ],
  notes:
    'The keyword "rape" appears in legitimate contexts too — fan-fiction warnings, news headlines, songs ("Rape Me" by Nirvana), historical references. The derived NonConsent label gates on AND-sexual to filter most. Even so, NonConsent has a contextual problem (consensual roleplay using NC words) that no purely-lexical detector can solve — pair with two-stage classification or score-tiered review for the full fix. See architecture doc.',
};

// ============================================================================
// DIAPER / ABDL
// Literal diaper-fetish terms.
// ============================================================================
export const DIAPER: LabelRegexSpec = {
  triggers: [
    'diaper',
    'diapers',
    'diapered',
    'pamper',
    'pampers',
    'abdl',
    'ddlg', // Daddy Dom / Little Girl — closely diaper-adjacent
    'omutsu', // Japanese for diaper
    'nappy',
    'nappies', // British English
  ],
  phrasePatterns: [
    'adult baby',
    'padded underwear',
    'padded pants',
    'pull[\\s-]up(s)?', // "pull-ups" the brand; sometimes ambiguous, but in fetish prompts usually means diaper
    'diaper change',
    'diaper rash',
    'diaper fetish',
    'wet diaper',
    'soggy diaper',
    'soiled diaper',
    'messy diaper',
    'dirty diaper',
    'crinkly diaper',
    'thick diaper',
  ],
  carveOutPatterns: [
    // "pampered" alone (luxury / spoiled context)
    'pampered (life|lifestyle|princess|royalty|guest)',
    'pampering (massage|spa|treatment)',
    // Pull-ups can mean exercise
    'pull[\\s-]up(s)? exercise',
    'pull[\\s-]ups? workout',
    // Nappy used to describe hair texture (not a fetish term in that context)
    'nappy hair',
  ],
  notes:
    'Diaper is a tight, closed-vocabulary fetish label. The LLM was firing on youth-coded prompts ("loli, baby") that have no actual diaper content. A pure literal-term match should eliminate that class of FP.',
};

// ============================================================================
// MENSTRUATION
// Literal period / menstrual-blood terms.
// ============================================================================
export const MENSTRUATION: LabelRegexSpec = {
  triggers: ['menstruation', 'menstrual', 'menstruating', 'menses', 'tampon', 'tampons', 'maxipad'],
  phrasePatterns: [
    'period blood',
    'period stain',
    'period sex',
    'menstrual blood',
    'menstrual cycle', // ambiguous but rare outside of biology context
    'on (her|my|their) period',
    'first period',
    'bloody pad',
    'sanitary pad',
    'menstrual pad',
    'menstrual fluid',
  ],
  carveOutPatterns: [
    // "Period" used as a time word (very common in non-menstruation contexts)
    'period (drama|piece|costume|setting|piece|clothing|attire|outfit|movie|film)',
    'time period',
    'period of time',
    '(victorian|edwardian|elizabethan|roman|medieval|renaissance|baroque|gothic) period',
    '(jurassic|cretaceous|triassic) period',
    'historical period',
    'long period',
    'short period',
    'school period',
    'lunch period',
    'grace period',
    'pay period',
    'punctuation period',
    'cooling period',
    'rest period',
    'waiting period',
    'transition period',
  ],
  notes:
    '"Period" is the trickiest term — it has many non-menstrual uses. Note that this label triggers on `tampon`/`menstrual` etc. so the bare word `period` is not even in the trigger list; only specific menstrual phrases (period blood, on her period) are. The carve-outs above defend against false matches if `period` is later added as a trigger.',
};

// ============================================================================
// SCAT
// Literal scat/feces fetish content.
// ============================================================================
export const SCAT: LabelRegexSpec = {
  triggers: [
    'scat',
    'feces',
    'fecal',
    'poop',
    'pooping',
    'pooped',
    'coprophilia',
    'coprophagia',
    'coprophilic',
  ],
  phrasePatterns: [
    'scat play',
    'scat fetish',
    'scat porn',
    'human waste',
    'human feces',
    'eating shit',
    'shit eating',
    'shitty diaper', // overlap with diaper but stronger scat signal
    'shitting (on|in|herself|himself)',
  ],
  carveOutPatterns: [
    // "Scat" is also a music style and a vocal technique
    'scat (singer|singing|music|jazz|solo|vocals|vocalist|melody|improvisation)',
    'jazz scat',
    'vocal scat',
    'scat[\\s-]style',
    // "Shit" as slang is extremely common; deliberately NOT in triggers to avoid
    // the flood of slang FPs. Specific phrasePatterns above catch fetish usage.
    // "poop deck" (nautical)
    'poop deck',
  ],
  notes:
    'The bare word "shit" is intentionally NOT a trigger because it appears constantly as slang. Fetish usage requires multi-word context ("eating shit", "scat play") which is captured in phrasePatterns. The "scat" music carve-out is significant — jazz/vocal context is a frequent FP source.',
};

// ============================================================================
// URINE
// Urine / urination / piss-play fetish content.
// ============================================================================
export const URINE: LabelRegexSpec = {
  triggers: [
    'urine',
    'urinating',
    'urination',
    'piss',
    'pissing',
    'omorashi', // anime term for desperate-to-urinate
  ],
  phrasePatterns: [
    'piss play',
    'urine play',
    'golden shower',
    'watersports (fetish|sex)', // disambiguate from kayaking etc
    'desperate to (pee|urinate)',
    'wetting (herself|himself|themselves|pants)',
    'pee (play|fetish)',
    'pissed (on|over|in)', // covers "pissed on her", "pissed in the bottle"
    // Pee alone is too generic — but pee in fetish context is specific
    'pee (porn|drinking|kink)',
    'piss drinking',
    'piss bottle',
  ],
  carveOutPatterns: [
    // "Pissed" as British/American slang for angry
    'pissed off',
    'pissed at',
    'pissed (about|because|when|that)',
    'so pissed',
    // Watersports as an actual sport
    '(kayaking|surfing|paddleboarding|sailing|swimming) watersports',
    'watersports (championship|tournament|competition|olympics)',
    // "Pee" can be a name or initial
    'cee pee',
    'jay pee',
    'em pee',
  ],
  notes:
    '"Piss" / "pissed" is one of the most ambiguous terms — both fetish AND British slang for anger. The trigger keeps the bare term but the carve-outs strip the most common slang patterns first. "Pee" alone is too generic; only context phrasePatterns (piss play, pee drinking) fire.',
};

// ============================================================================
// BESTIALITY
// Sexual content between a real (non-anthropomorphic) animal and a human.
// Closed core list with extensive carve-outs for anthro/furry/Pokemon/sex-position-name false positives.
// ============================================================================
export const BESTIALITY: LabelRegexSpec = {
  triggers: [
    'bestiality',
    'beastiality',
    'bestial',
    'beastial',
    'zoophilia',
    'zoophile',
    'zoophilic',
  ],
  phrasePatterns: [
    'animal sex',
    'sex with (a |an |the )?(dog|horse|cat|wolf|donkey|cow|bull|pig|goat|sheep|cattle|stallion|mare|stag)',
    '(dog|horse|cat|wolf|donkey|cow|bull|pig|goat|sheep|stallion|mare) (mating|breeding) with (a |the )?(woman|man|human|girl|boy)',
    '(woman|man|girl|boy|human) (mating|breeding) with (a |an |the )?(dog|horse|cat|wolf|donkey|cow|bull|pig|goat|sheep|stallion|mare)',
    'human and (a |an |the )?(real|live) (dog|horse|cat|wolf|donkey|cow|bull|pig|goat|sheep) (sex|fucking|mating|breeding)',
  ],
  carveOutPatterns: [
    // Anthropomorphic / furry — these are NOT real animals
    'anthro(\\w+)?',
    'anthropomorphic',
    'furry',
    'kemono',
    'kemonomimi',
    '(dog|cat|wolf|fox|bunny|rabbit|mouse|horse|dragon|sergal) girl',
    '(dog|cat|wolf|fox|bunny|rabbit|mouse|horse|dragon|sergal) boy',
    'monster girl',
    'monster boy',
    'slime girl',
    'demi-human',
    'demihuman',
    'centaur(ess)?',
    'lamia',
    'naga',
    'harpy',
    'mermaid',
    'merman',
    'merfolk',
    // Animal-feature tags on otherwise-human characters
    '(dog|cat|wolf|fox|rabbit|horse) ears',
    '(dog|cat|wolf|fox|rabbit) tail',
    'animal ears',
    'fur(ry)? body',
    'fluffy tail',
    // Pokemon franchise names — fictional creatures, not real animals
    'pokemon',
    'pikachu',
    'charizard',
    'eevee',
    'sylveon',
    'lopunny',
    'cinderace',
    'lucario',
    'gardevoir',
    'mewtwo',
    'mew\\b',
    'snorlax',
    'rapidash',
    'ponyta',
    'zoroark',
    'meowth',
    'persian',
    'arcanine',
    'growlithe',
    'vaporeon',
    'jolteon',
    'flareon',
    'espeon',
    'umbreon',
    'leafeon',
    'glaceon',
    'steenee',
    // Other fictional anthro franchises
    'digimon',
    'my little pony',
    'mlp\\b',
    'sonic the hedgehog',
    'sonic\\b',
    'zootopia',
    'kemono friends',
    'helluva boss',
    'hazbin hotel',
    'beastars',
    // Sex position names that contain animal words — HUMAN positions, not bestiality
    'doggystyle',
    'doggy style',
    'doggy-style',
    'cowgirl',
    'reverse cowgirl',
    'missionary',
    'pony[\\s-]?play', // BDSM pony-play is human roleplay, not bestiality
    // "Animal" used in non-sexual scene context
    '(stuffed|plush|toy) (dog|cat|horse|wolf|rabbit)',
    '(dog|cat|horse|wolf|rabbit) (toy|plush|stuffed)',
    '(painting|portrait|photo) of (a |the )?(dog|cat|horse|wolf|rabbit)',
  ],
  notes:
    'Bestiality is the trickiest closed-vocabulary label because the literal terms (bestiality, zoophilia) are rare; the harder cases require detecting "real animal + human + sexual" together. The phrasePatterns try to catch explicit pair phrases; the long carve-out list defends against the largest classes of FPs (anthro/furry/Pokemon/sex-position-names). Even with these, this label is borderline — if FP rate stays high in production telemetry, consider keeping a thin LLM second-pass for cases that match the broad phrase patterns but might be carved-out anthro content.',
};

// ============================================================================
// Index — single export for consumers
// ============================================================================
export const SCANNER_LABEL_REGEX: Record<string, LabelRegexSpec> = {
  familial: FAMILIAL,
  'nonconsent-keyword': NONCONSENT_KEYWORD,
  diaper: DIAPER,
  menstruation: MENSTRUATION,
  scat: SCAT,
  urine: URINE,
  bestiality: BESTIALITY,
};

// ============================================================================
// Detector — runs a single label's regex spec against a prompt string and
// returns whether it matched and (for debugging) why.
//
// Algorithm:
//   1. Normalize the text (lowercase, strip weight syntax, collapse whitespace).
//   2. Strip carve-out patterns from the normalized text so trigger matching
//      doesn't see false-positive contexts.
//   3. Check phrasePatterns first (multi-word patterns are more specific
//      than bare words — "forced sex" should match before "forced" elsewhere).
//   4. For labels that have structured pair-detection fields
//      (pluralImpliesPair / soloUnambiguous / possessivePronouns /
//      pairPhraseConnectors): apply Familial-style pair logic — fire when
//      the text contains a clear two-person relation, not just a single
//      family-role word.
//   5. For simple labels: fire on any whole-word trigger match.
//
// Returns a structured result with the reason a label fired (or didn't) so
// the consumer can surface the match for moderator review and debugging.
// ============================================================================

export interface LabelMatchResult {
  /** The label name that was checked. */
  label: string;
  /** Whether the regex spec considers this label to be triggered. */
  matched: boolean;
  /** Why it matched (or what kind of negative result). Human-readable. */
  reason: string;
  /** Specific terms / phrases that matched. Empty if not matched. */
  matchedTerms: string[];
  /** The normalized text that was actually checked (post carve-out strip). */
  normalizedText: string;
}

const ESCAPE_REGEX_CHARS = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(s: string): string {
  return s.replace(ESCAPE_REGEX_CHARS, '\\$&');
}

/** Lowercase, strip weight syntax, flatten brackets, collapse whitespace. */
export function normalizePromptForRegex(text: string): string {
  if (!text) return '';
  let s = text.toLowerCase();
  // (term:1.4) → term — A1111-style weight syntax
  s = s.replace(/\(([^()]+?):\s*-?\d+(?:\.\d+)?\)/g, '$1');
  // Flatten remaining brackets/parens to spaces so weight syntax remnants
  // don't break whole-word boundaries (e.g. "(young)" → " young ").
  s = s.replace(/[[\](){}]+/g, ' ');
  s = s.replace(/\s+/g, ' ');
  return s.trim();
}

/** Build a whole-word regex for a single term. */
function buildWholeWordPattern(term: string): RegExp {
  return new RegExp(`(?<![a-z0-9])${escapeRegex(term)}(?![a-z0-9])`, 'i');
}

/** Build a phrase pattern that allows flexible whitespace between words. */
function buildPhrasePattern(phraseSource: string): RegExp {
  // The phraseSource may already contain regex meta-characters intended
  // by the author (e.g. "non[\\s-]consensual"). We do NOT escape those —
  // we just normalize internal whitespace to \s+ so weight syntax doesn't
  // break us.
  const normalized = phraseSource.replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![a-z0-9])${normalized}(?![a-z0-9])`, 'i');
}

/** Strip carve-out matches from the text so trigger matching doesn't see them. */
function stripCarveOuts(text: string, patterns: string[] | undefined): string {
  if (!patterns || patterns.length === 0) return text;
  let out = text;
  for (const pattern of patterns) {
    const re = new RegExp(pattern, 'gi');
    out = out.replace(re, ' ');
  }
  // Collapse whitespace introduced by replacements
  return out.replace(/\s+/g, ' ').trim();
}

/** First trigger that matches the text, or null. */
function findTriggerMatch(text: string, triggers: string[]): string | null {
  for (const term of triggers) {
    if (buildWholeWordPattern(term).test(text)) return term;
  }
  return null;
}

/** First phrase pattern that matches, or null. */
function findPhraseMatch(text: string, phrases: string[] | undefined): string | null {
  if (!phrases || phrases.length === 0) return null;
  for (const phrase of phrases) {
    if (buildPhrasePattern(phrase).test(text)) return phrase;
  }
  return null;
}

/**
 * Familial-style pair detection. Returns the reason if a pair is detected,
 * or null otherwise.
 */
function detectPair(
  text: string,
  spec: LabelRegexSpec
): { reason: string; matched: string } | null {
  // 1. Pair-phrase: "X CONNECTOR Y" where X and Y are both triggers
  if (spec.pairPhraseConnectors && spec.pairPhraseConnectors.length > 0) {
    const triggers = spec.triggers.map(escapeRegex).join('|');
    const connectors = spec.pairPhraseConnectors.map(escapeRegex).join('|');
    const pairRegex = new RegExp(
      `(?<![a-z0-9])(${triggers})\\s+(${connectors})\\s+(${triggers})(?![a-z0-9])`,
      'i'
    );
    const m = text.match(pairRegex);
    if (m) return { reason: 'pair-phrase', matched: m[0] };
  }

  // 2. Plural-implies-pair: a single plural family term implies 2+ people
  if (spec.pluralImpliesPair) {
    for (const plural of spec.pluralImpliesPair) {
      if (buildWholeWordPattern(plural).test(text)) {
        return { reason: `plural-implies-pair:${plural}`, matched: plural };
      }
    }
  }

  // 3. Solo-unambiguous: terms like "nephew" that inherently imply a relation
  if (spec.soloUnambiguous) {
    for (const solo of spec.soloUnambiguous) {
      if (buildWholeWordPattern(solo).test(text)) {
        return { reason: `solo-unambiguous:${solo}`, matched: solo };
      }
    }
  }

  // 4. Possessive: "her nephew", "his sister"
  if (spec.possessivePronouns && spec.possessivePronouns.length > 0) {
    const pronouns = spec.possessivePronouns.map(escapeRegex).join('|');
    const targets = spec.triggers.map(escapeRegex).join('|');
    const possessiveRegex = new RegExp(
      `(?<![a-z0-9])(${pronouns})\\s+(${targets})(?![a-z0-9])`,
      'i'
    );
    const m = text.match(possessiveRegex);
    if (m) return { reason: `possessive:${m[0]}`, matched: m[0] };
  }

  // 5. Two distinct triggers in the same prompt
  const distinct = new Set<string>();
  for (const term of spec.triggers) {
    if (buildWholeWordPattern(term).test(text)) {
      distinct.add(term);
      if (distinct.size >= 2) {
        return {
          reason: `two-distinct:${[...distinct].join(',')}`,
          matched: [...distinct].join('+'),
        };
      }
    }
  }

  return null;
}

/** Run a single label's spec against already-normalized text. */
function matchSpecAgainstNormalized(
  label: string,
  spec: LabelRegexSpec,
  normalized: string
): LabelMatchResult {
  const stripped = stripCarveOuts(normalized, spec.carveOutPatterns);

  // 1. Phrase patterns first (most specific)
  const phraseMatch = findPhraseMatch(stripped, spec.phrasePatterns);
  if (phraseMatch) {
    return {
      label,
      matched: true,
      reason: `phrase:${phraseMatch}`,
      matchedTerms: [phraseMatch],
      normalizedText: stripped,
    };
  }

  // 2. Pair detection for labels with structured pair fields
  const hasPairFields =
    !!spec.pluralImpliesPair ||
    !!spec.soloUnambiguous ||
    !!spec.possessivePronouns ||
    !!spec.pairPhraseConnectors;
  if (hasPairFields) {
    const pair = detectPair(stripped, spec);
    if (pair) {
      return {
        label,
        matched: true,
        reason: pair.reason,
        matchedTerms: [pair.matched],
        normalizedText: stripped,
      };
    }
    return {
      label,
      matched: false,
      reason: 'no-pair-detected',
      matchedTerms: [],
      normalizedText: stripped,
    };
  }

  // 3. Simple labels: any single trigger match fires
  const triggerMatch = findTriggerMatch(stripped, spec.triggers);
  if (triggerMatch) {
    return {
      label,
      matched: true,
      reason: `trigger:${triggerMatch}`,
      matchedTerms: [triggerMatch],
      normalizedText: stripped,
    };
  }

  return {
    label,
    matched: false,
    reason: 'no-trigger-or-phrase',
    matchedTerms: [],
    normalizedText: stripped,
  };
}

/**
 * Detect whether the given text matches multiple labels' regex specs.
 * Normalizes the text once (lowercase + strip weight syntax) and runs the
 * per-label carve-out + trigger / pair detection for each label against the
 * shared normalized text.
 *
 * Returns results in the same order as the `labels` input. Throws on unknown
 * labels — pass only names that exist in SCANNER_LABEL_REGEX.
 */
export function matchLabels(labels: string[], text: string): LabelMatchResult[] {
  // Validate all labels up-front so callers fail fast on typos rather than
  // partway through the loop.
  for (const label of labels) {
    if (!(label in SCANNER_LABEL_REGEX)) {
      throw new Error(
        `Unknown scanner-regex label "${label}". Known: ${Object.keys(SCANNER_LABEL_REGEX).join(
          ', '
        )}`
      );
    }
  }

  const normalized = normalizePromptForRegex(text);
  return labels.map((label) =>
    matchSpecAgainstNormalized(label, SCANNER_LABEL_REGEX[label], normalized)
  );
}

/**
 * Single-label convenience wrapper around `matchLabels`. Use `matchLabels`
 * directly when checking multiple labels on the same text to avoid
 * re-normalizing the prompt.
 */
export function matchLabel(label: string, text: string): LabelMatchResult {
  return matchLabels([label], text)[0];
}

/**
 * Detect against ALL labels defined in SCANNER_LABEL_REGEX. Convenience for
 * the common "run every regex label and see what fires" use case.
 */
export function matchAllLabels(text: string): LabelMatchResult[] {
  return matchLabels(Object.keys(SCANNER_LABEL_REGEX), text);
}
