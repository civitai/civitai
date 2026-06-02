/**
 * Scanner-policies test bench — sysRedis seed.
 *
 * Idempotent. Re-running skips any candidate whose `name` already exists for
 * the same (mode, label).
 *
 * Usage:
 *   pnpm seed:scanner-policies                       (uses C:/temp/_xg-export.json)
 *   pnpm seed:scanner-policies path/to/export.json
 *
 * What it does:
 *   1. For every label in the bulk xguard-manager export (12 prompt-mode + 15
 *      text-mode), inserts the currently-shipped policy as one
 *      `status: shipped, active: false` candidate named "Live".
 *   2. Inserts the historical iterations from this session as archived
 *      candidates (Young 4-11, Suggestive A-H, Explicit OptionA/B/AB +
 *      CandidateA-H). Marked `status: 'archived'` so they don't accidentally
 *      get re-tested without an explicit unarchive.
 *
 * To populate prod sysRedis: override REDIS_SYS_URL inline or via a
 * `.env.prod-seed` file. The script is read-modify-no-destroy — it only
 * writes new fields, never overwrites or deletes existing ones.
 */
import { readFileSync, existsSync } from 'fs';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { listCandidates, upsertCandidate } from '~/server/services/scanner-policies.service';
import type {
  ScannerPolicyMode,
  UpsertCandidateInput,
} from '~/server/schema/scanner-policies.schema';

const SEED_USER_ID = 1;

type ExportLabel = {
  name: string;
  threshold: number;
  action: string;
  policy: string;
};

type ExportPayload = {
  prompt?: { systemPrompt?: string; labels?: ExportLabel[] };
  text?: { systemPrompt?: string; labels?: ExportLabel[] };
};

// ============================================================================
// HISTORICAL YOUNG POLICIES
// ============================================================================

const YOUNG_OPTION_4 = `- x: Civitai Prompt Underage Subject
  - Choose x when the prompt's positive section describes, asserts, or implies a minor (under 18) through terms like child, kid, toddler, shota, loli, cub, elementary student, schoolgirl, schoolboy, aged down, or explicit ages under 18.
  - An explicit adult age in the positive prompt (18+, 21, 25, "adult", "mature", "MILF", "elderly", "old woman", "old man") OVERRIDES all implicit youth signals.
  - "Young adult", "young man", "young woman", "young [profession]" (e.g. "young actor", "young model") are adult-vocabulary phrasings — sec unless the prompt also asserts an under-18 age.
  - Anime, cartoon, stylized, chibi, or any art style is sec on its own. Stylized art is not by itself a youth signal. Explicit/sexual content in an anime style is sec for THIS label unless explicit youth terms are also present.
  - Adult body archetypes and fashion styles are sec: petite, shortstack, small frame, skindentation, cute face, gothic lolita features, lolita fashion (as a fashion descriptor), chibi proportions.
  - Size descriptors (tiny, small, shrunken) only count as youth signals when explicitly applied to age. When applied to objects, scenery, vehicles, or buildings, they are not youth signals.
  - A character's source franchise does not determine age. Judge by the body description and asserted age in the prompt, not by the franchise's target audience.
  - 1girl, 1boy, 2girls, 2boys alone are not youth signals.
  - Anthropomorphic characters (anthro, furry, dog girl, cat girl, kemono, monster girl, demi-human, slime girl, dragon girl, kemonomimi, fox girl) with adult body proportions are sec for this label. A non-human or partially-non-human body form does not indicate youth.
  - Foreign-language youth terms are youth signals (e.g. Vietnamese "học sinh" = student, Russian "девочка" = girl/young girl, Chinese "学生" = student, Japanese "女子高生" = high school girl).
  - "Mom and son", "father and daughter", or any sexual content explicitly framing one participant as a parent's child is a youth signal regardless of described body type.
  - For this binary check, only use x or sec.`;

const YOUNG_OPTION_5 = `- x: Civitai Prompt Underage Subject
  - PRIMARY RULE — TRIGGER ON ANY OF THESE: If the positive prompt contains any of the following terms as whole words or phrases (case-insensitive), choose x. This rule is dispositive unless an adult-anchor override applies (see below).
    - English youth nouns: child, children, kid, kids, toddler, baby, infant, minor, minors, underage, shota, loli, lolicon, cub, schoolgirl, schoolboy, schoolgirls, schoolboys, elementary student, kindergartner, preschooler, aged down, age regression, age-regressed
    - English age qualifiers: teen, teens, teenage, teenager, teenagers, preteen, pre-teen, tween
    - "Young" qualifying a child-noun: young girl, young boy, young son, young daughter, young couple, young child, young kid
    - "Little" qualifying a person: little girl, little boy, little child, little kid
    - Body-as-child: toddler body, toddler proportion, small toddler, baby body, infant body
    - Explicit ages under 18 written numerically or as words
    - Foreign-language youth terms (whole-phrase): học sinh, девочка, 学生, 女子高生, 少女, ロリ, 여학생
    - Family child-framing in any context: "mom and son", "father and daughter", "mother and son", "dad and daughter"
  - ADULT-ANCHOR OVERRIDE: If the positive prompt asserts an explicit adult age (18+, 18, 19, 20, 21, 22+, "in her 20s", etc.) OR contains an adult-anchor term ("adult", "mature", "MILF", "GILF", "elderly", "old woman", "old man", "cougar", "hag"), classify as sec — even if school uniforms, anime style, petite body type, or named characters are also present.
  - ADULT-VOCABULARY EXCEPTIONS: "young adult", "young man", "young woman", "young actor", "young model", "young athlete", "young professional" are adult-vocabulary phrasings — sec UNLESS the prompt ALSO contains another explicit youth signal from the PRIMARY RULE list above.
  - Art style alone is sec: anime, cartoon, chibi, stylized.
  - Adult body archetypes are sec: petite, shortstack, small frame, skindentation, cute face, gothic lolita features, lolita fashion, chibi proportions.
  - Size descriptors (tiny, small, shrunken) applied to non-bodies are sec.
  - A character's source franchise does not determine age.
  - 1girl, 1boy, 2girls, 2boys alone are not youth signals.
  - Anthropomorphic characters (anthro, furry, dog girl, cat girl, kemono, monster girl, demi-human, slime girl, dragon girl, kemonomimi, fox girl) with adult body proportions are sec UNLESS the prompt also contains an explicit youth term from the PRIMARY RULE list.
  - For this binary check, only use x or sec.`;

const YOUNG_OPTION_6 = `- x: Civitai Prompt Underage Subject
  - PRIMARY RULE — TRIGGER ON ANY OF THESE: If the positive prompt contains any of the following terms as whole words or phrases (case-insensitive), choose x. This rule is dispositive unless an adult-anchor override or carve-out applies (see below).
    - English youth nouns: child, children, kid, kids, toddler, baby, infant, minor, minors, underage, shota, loli, lolicon, cub, schoolgirl, schoolboy, schoolgirls, schoolboys, elementary student, kindergartner, preschooler, aged down, age regression, age-regressed
    - English age qualifiers: teen, teens, teenage, teenager, teenagers, preteen, pre-teen, tween
    - "Young" qualifying a child-noun: young girl, young boy, young son, young daughter, young child, young kid
    - "Little" qualifying a person: little girl, little boy, little child, little kid
    - Body-as-child: toddler body, toddler proportion, small toddler, baby body, infant body
    - Explicit ages under 18 written numerically or as words
    - Foreign-language youth terms (whole-phrase): học sinh, девочка, 学生, 女子高生, 少女, ロリ, 여학생
    - Family child-framing: "mom and son", "father and daughter", "mother and son", "dad and daughter"
  - ADULT-ANCHOR OVERRIDE (dispositive — WINS over the primary rule): If the positive prompt asserts an explicit adult age (18, 19, 20, 21, 22+, "in her 20s", "in his 30s", "late teens", "early twenties", "20-something", "thirtysomething") OR contains an adult-anchor term ("adult", "mature", "MILF", "GILF", "elderly", "old woman", "old man", "cougar", "hag", "voluptuous adult", "mature female"), classify as sec.
  - "YOUNG + ADULT-NOUN" CARVE-OUT: The following phrases are adult vocabulary by default and classify as sec UNLESS the prompt ALSO contains an explicit youth-noun from the PRIMARY RULE list: "young adult", "young man", "young woman", "young female", "young lady", "young person", "young people", "young actor", "young model", "young athlete", "young professional", "young college girl", "young college student", "young couple", "young anime-style woman", "young anime woman".
  - ANTHRO/FURRY CARVE-OUT: Anthropomorphic, furry, feral, or fictional non-human characters (anthro, furry, feral, dog girl, cat girl, kemono, monster girl, demi-human, slime girl, dragon girl, kemonomimi, fox girl, rabbit girl, wolf girl, fur, scales, snout, paws, claws, tail, animal ears as a primary descriptor) are sec UNLESS the prompt ALSO contains a hard child-noun from the PRIMARY RULE list. Descriptors like "young", "small", "petite", "cute", "tiny", "chibi" do NOT override the anthro carve-out — they routinely describe stylized adult anthro characters.
  - FRANCHISE-TAG AGE-MARKER CARVE-OUT: When a youth term appears inside parenthetical franchise context (e.g. "character_name (teenager) (franchise)"), treat the parenthetical age tag as a character-design marker rather than an asserted age — UNLESS the rest of the prompt independently contains a primary-rule youth signal.
  - Art style alone is sec: anime, cartoon, chibi, stylized. An anime/cartoon art style is NEVER by itself a youth signal.
  - Adult body archetypes are sec: petite, shortstack, small frame, skindentation, cute face, gothic lolita features, lolita fashion, chibi proportions, slim, slender, hourglass.
  - Size descriptors (tiny, small, shrunken) applied to non-bodies (objects, scenery, vehicles, buildings) are sec.
  - 1girl, 1boy, 2girls, 2boys alone are not youth signals.
  - For this binary check, only use x or sec.`;

const YOUNG_OPTION_7 = `- x: Civitai Prompt Underage Subject

  Your task: read the image-generation prompt and decide whether it requests an image of a person under 18.

  Choose x if the prompt asks for a minor — anyone under 18. Look for:
  - Explicit youth nouns: child, kid, toddler, baby, infant, schoolgirl, schoolboy, elementary student, kindergartner, preschooler, loli, shota, cub
  - Age qualifiers: teen, teenage, teenager, preteen, tween
  - An explicit age under 18
  - "Little/young" + child noun: little girl, little boy, young son, young daughter
  - Foreign-language youth terms: học sinh (Vietnamese student), девочка (Russian young girl), 学生 (Chinese student), 女子高生 (Japanese high school girl), 少女, ロリ, 여학생 (Korean female student)
  - Parent-child framing in a sexual context: mom and son, father and daughter

  Choose sec if the prompt is about an adult or non-human:
  - Explicit adult age (18+, "20s", "30s", "in her late twenties", "early twenties", numeric age 18 or higher)
  - Adult-anchor terms: adult, mature, MILF, GILF, elderly, voluptuous adult, mature female, old woman, old man
  - "Young woman", "young man", "young female", "young lady", "young actor", "young model", "young couple", "young college girl", "young athlete", "young professional" — these are adult English vocabulary, NOT youth signals
  - Anthro/furry/feral characters (anthro, furry, monster girl, dragon girl, kemono, dog girl, cat girl, slime girl, fox girl, wolf girl, mouse girl) without an explicit child-noun from the trigger list
  - Anime/cartoon/chibi art style alone — not a youth signal
  - Body descriptors (petite, small frame, slim, slender, hourglass, chibi proportions) without an age claim
  - The prompt has no clear human subject at all (e.g. "Naked", a vague tag list)

  Reading guidance:
  - When age is genuinely unclear from the prompt, prefer sec. The goal is to flag prompts that clearly request a minor, not every prompt where one might be possible.
  - "(young:3)" or "((young))" in weight syntax is the literal word "young". Apply the same rules.
  - Franchise names do not determine age. Judge by the prompt's actual words.

  Output: x or sec.`;

const YOUNG_OPTION_8 = `- x: Civitai Prompt Underage Subject

  Choose x if the positive image-generation prompt clearly requests an image of a person under 18 — through explicit youth terms (child, kid, toddler, loli, shota, schoolgirl, teen, teenager, preteen), an age under 18, or parent-child sexual framing.

  Choose sec for everything else:
  - Adult age or adult-anchor terms (18+, mature, MILF, elderly, etc.)
  - "Young woman/man/female/couple/actor/model" — adult vocabulary
  - Anthro/furry/feral characters without explicit child terms
  - Anime/cartoon style or body descriptors (petite, slim) without age claim
  - Vague or ambiguous prompts

  When unsure, prefer sec.

  Output: x or sec.`;

const YOUNG_OPTION_10 = `- x: Civitai Prompt Underage Subject
  - Categorize the subject into CHILD (under 13), TEEN (13-17), or YOUNG-ADULT (18+) then apply the bucket's rule.
  - APPLY THESE DISPOSITIVE OVERRIDES FIRST. If any of these match, classify as sec regardless of any other signal in the prompt — even if youth-coded words like "schoolgirl", "school uniform", "young", "petite", or "cute" are also present:
  - DISPOSITIVE SEC #1 — ADULT AGE OR ANCHOR: If the positive prompt contains any explicit adult age (18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30+, "20yo", "23yo", "in her 20s", "in his 30s", "early twenties", "late teens", "20-something", "thirtysomething") OR any adult-anchor word (adult, mature, MILF, GILF, elderly, voluptuous adult, mature female, old woman, old man, cougar, hag) — choose sec. This wins over any youth tag in the same prompt.
  - DISPOSITIVE SEC #2 — ANTHRO/FURRY/FERAL: If the positive prompt describes the subject as anthropomorphic, furry, feral, kemono, kemonomimi, monster girl, monster boy, demi-human, dragon girl, dog girl, cat girl, fox girl, wolf girl, rabbit girl, mouse girl, slime girl, sergal, anthro of any species, furry of any species, or a feral (non-anthro animal-form fictional creature) — choose sec, EVEN IF the prompt is sexually explicit. The only exception is if the prompt also literally contains "loli", "shota", "cub", "child", "kid", "toddler", "baby", "infant", or an explicit age under 18 — only then choose x.
  - DISPOSITIVE SEC #3 — "YOUNG X" ADULT VOCABULARY: If the prompt contains "young woman", "young man", "young female", "young lady", "young actor", "young model", "young athlete", "young professional", "young couple", "young college girl", "young college boy", "young adult", "young guy", "young person" — these are adult English vocabulary. Choose sec. The exception: only choose x if the SAME prompt ALSO contains a literal CHILD-bucket term (child, kid, toddler, baby, infant, loli, shota, cub, schoolgirl OR an explicit age under 18). Do not treat "young man" or "young woman" as a youth signal on their own.
  - DISPOSITIVE SEC #4 — FRANCHISE NAMES WITH "TEEN" / "YOUNG": Franchise titles or character names that contain "teen" or "young" (e.g. "Teen Titans", "Young Justice", "Young Avengers") are franchise references, NOT age assertions about the subject. Choose sec unless the prompt independently asserts an under-18 age or contains a CHILD-bucket term.
  - After applying the dispositive overrides, if none matched, use the bucket rules below:
  - CHILD bucket — choose x. Triggered by literal terms: child, children, kid, kids, toddler, baby, infant, preschooler, kindergartner, elementary student, little girl, little boy, little child, loli, lolicon, shota, cub, young son, young daughter, young child, an explicit age under 13, or family child-framing in sexual contexts (mom and son, father and daughter, mother and son).
  - TEEN bucket — choose x. Triggered by literal terms: teen, teens, teenage, teenager, preteen, pre-teen, tween, middle schooler, OR an explicit age between 13 and 17 (13yo through 17yo).
  - Note: "schoolgirl", "schoolboy", "school uniform", "high schooler", and similar school-context tags are NOT default TEEN triggers on their own. They are commonly used as adult cosplay/fetish in image-generation. Only treat them as a TEEN trigger if the prompt also contains an explicit teen-age term or no adult-anchor signal is present.
  - YOUNG-ADULT bucket — choose sec.
  - Foreign-language youth terms are youth signals: học sinh, девочка, 学生, 女子高生, 少女, ロリ, 여학생.
  - Style alone (anime, cartoon, chibi, stylized) is NOT a youth signal.
  - Adult body archetypes (petite, shortstack, small frame, cute face, slim, slender, hourglass, chibi proportions) are NOT youth signals.
  - Size descriptors (tiny, small, shrunken) applied to non-bodies are sec.
  - 1girl, 1boy, 2girls, 2boys alone are not youth signals.
  - When the bucket is unclear, prefer sec (YOUNG-ADULT).
  - For this binary check, only use x or sec.`;

const YOUNG_OPTION_11 = `- x: Civitai Prompt Underage Subject
  - First mentally categorize the requested subject into one of three buckets, then apply the rule for that bucket.
  - EMPHASIS-STACK PATTERN: If the positive prompt contains "young" with emphasis (weight syntax like (young:1.3), repeated parens like ((young)) or (((young))), or capitalization like YOUNG) — OR contains "young" alongside a person tag like "girl" or "boy" — AND ALSO contains two or more body/appearance descriptors from this set (petite, cute, small, tiny, innocent, slim, delicate, smooth, soft body, small body, cute face) — place the subject in the CHILD bucket and choose x. The combination of emphasized or stacked youth-coded descriptors signals intent to depict a minor even when individual descriptors have carve-outs. The ADULT-ANCHOR OVERRIDE below still wins — if an explicit adult age (18+, 21, 25, etc.) or adult anchor (MILF, mature, etc.) is present, choose sec regardless of this stacking.
  - CHILD bucket (under 13) — choose x. Triggered by: child, children, kid, kids, toddler, baby, infant, preschooler, kindergartner, elementary student, little girl, little boy, little child, loli, lolicon, shota, cub, young son, young daughter, young child, an explicit age under 13 (12yo, "ten years old", etc.), or family child-framing in sexual contexts (mom and son, father and daughter).
  - TEEN bucket (13-17) — choose x. Triggered by: teen, teens, teenage, teenager, preteen, pre-teen, tween, middle schooler, high schooler, schoolgirl, schoolboy, school uniform paired with sexual content, or an explicit age between 13 and 17 (13yo, 14yo, 15yo, 16yo, 17yo, "fifteen years old", etc.).
  - YOUNG-ADULT bucket (18+) — choose sec. This bucket includes: "young woman", "young man", "young female", "young lady", "young actor", "young model", "young athlete", "young professional", "young college girl", "young couple", "young adult". The English word "young" in front of an adult noun is adult vocabulary, NOT a youth signal. Also sec: "young person" without further context, "young East Asian woman", "beautiful young face" when the rest of the prompt describes an adult body or scene.
  - ADULT-ANCHOR OVERRIDE: If the positive prompt asserts an explicit adult age (18, 19, 20, 21+, "in her 20s", "early twenties", "late teens", "20-something", "thirtysomething") OR contains an adult-anchor term (adult, mature, MILF, GILF, elderly, voluptuous adult, mature female, old woman, old man, cougar), classify as sec — even if school uniforms, anime style, schoolgirl tags, or petite descriptors are also present. Adult age wins over schoolgirl tags AND over the emphasis-stack pattern.
  - ANTHRO carve-out: anthropomorphic, furry, feral, or fictional non-human characters (anthro, furry, feral, dog girl, cat girl, kemono, monster girl, demi-human, slime girl, dragon girl, kemonomimi, fox girl, rabbit girl, wolf girl) are sec UNLESS the prompt also contains an explicit child-noun from the CHILD bucket.
  - Foreign-language youth terms are youth signals: học sinh (Vietnamese student → TEEN), девочка (Russian young girl → CHILD or TEEN depending on context), 学生 (Chinese student → TEEN), 女子高生 (Japanese high school girl → TEEN), 少女 (Japanese girl → TEEN), ロリ (Japanese loli → CHILD), 여학생 (Korean female student → TEEN).
  - Style alone (anime, cartoon, chibi, stylized) is NOT a youth signal. Place the subject in YOUNG-ADULT or check the actual prompt content.
  - Adult body archetypes (petite, shortstack, small frame, cute face, slim, slender, hourglass, chibi proportions) are NOT youth signals on their own — these describe adult body types. They DO count toward the emphasis-stack rule above when 2+ are present alongside emphasized or paired "young".
  - Size descriptors (tiny, small, shrunken) applied to non-bodies (objects, scenery, vehicles) are sec.
  - 1girl, 1boy, 2girls, 2boys alone are not youth signals — place in YOUNG-ADULT until age is clarified.
  - When the bucket is genuinely unclear, prefer sec (YOUNG-ADULT).
  - Parenthetical age tags inside franchise context ("name (teenager) (franchise)") are character-design markers, not asserted ages.
  - For this binary check, only use x or sec.`;

// ============================================================================
// SUGGESTIVE CANDIDATES (A through H)
// ============================================================================

const SUGGESTIVE_A = `- x: Civitai Prompt Suggestive
  - Choose x when the prompt requests sexually-charged content: suggestive posing, revealing or partial-coverage clothing in a sexualized context, sensual framing, sexual undertones, implied sex, lingerie/swimwear in sexualized context, or explicit sexual content.
  - Explicit sexual content (nudity, visible genitals, depicted sex acts) is ALSO x for this label — explicit is a subset of suggestive.
  - Medical, anatomical, or biological descriptions without sexual framing are sec.
  - Swimwear, exposed shoulders, or partial clothing in non-sexual contexts (beach, sport, swimsuit competition, athletic wear, modest fashion) are sec.
  - Fashion photography, runway shoots, modeling portfolios, glamour magazine style, editorial fashion, designer clothing displays — sec UNLESS the prompt explicitly adds sexual framing terms (sexy, seductive, alluring, lust, erotic, NSFW, sensual).
  - Standard portraiture, headshots, professional photography without explicit sexual framing is sec.
  - For this binary check, only use x or sec.`;

const SUGGESTIVE_B = `- x: Civitai Prompt Suggestive
  - Choose x when the prompt would meaningfully evoke a sexually-charged response in an average adult viewer: explicit sexually-charged posing (spread legs, sticking out tongue, ahegao, suggestive eye contact), revealing clothing in clearly sexualized framing (lingerie + bedroom, see-through + nude, micro-bikini + provocative pose), sensual narrative (seductive, alluring, sexy, erotic, suggestive, lewd, lust, ecstasy, moaning), implied sex (couple in bed undressed, post-sex, afterglow), OR any content that qualifies as explicit (nudity, visible genitals, depicted sex acts).
  - The prompt must contain at least ONE term from a sexual-charge category above. Generic appearance descriptors (beautiful, gorgeous, pretty, cute, attractive) alone are NOT sexual signals.
  - Medical, anatomical, biological descriptions without sexual framing are sec.
  - Swimwear, exposed shoulders, partial clothing in non-sexual contexts (beach, sport, swimsuit competition, athletic wear, modest fashion) are sec.
  - Standard portraiture, fashion, glamour photography without explicit sexual framing is sec.
  - For this binary check, only use x or sec.`;

const SUGGESTIVE_C = `- x: Civitai Prompt Suggestive
  - Choose x when the prompt requests sexually-charged content: suggestive posing, revealing or partial-coverage clothing in a sexualized context, sensual framing, sexual undertones, implied sex, lingerie/swimwear in sexualized context, or explicit sexual content.
  - Explicit sexual content (nudity, visible genitals, depicted sex acts) is ALSO x for this label — explicit is a subset of suggestive.
  - Only the POSITIVE prompt counts as a request. Sexual or suggestive terms appearing ONLY in the negative prompt are avoidance signals (the user is asking that content NOT appear in the output) — classify as sec for this label regardless of how many such terms are listed there.
  - Medical, anatomical, or biological descriptions without sexual framing are sec.
  - Swimwear, exposed shoulders, or partial clothing in non-sexual contexts (beach, sport, swimsuit competition, athletic wear, modest fashion) are sec.
  - Standard portraiture, fashion, or glamour photography without explicit sexual framing is sec.
  - For this binary check, only use x or sec.`;

const SUGGESTIVE_E = `- x: Civitai Prompt Suggestive
  - Choose x when the positive prompt requests sexually-charged content: suggestive posing, sensual framing, sexual undertones, implied sex, lingerie/swimwear in sexualized context, or explicit sexual content (which is a subset).
  - Medical, anatomical, biological descriptions and standard portraiture without sexual framing are sec.
  - For this binary check, only use x or sec.`;

const SUGGESTIVE_F = `- x: Civitai Prompt Suggestive
  - This label is the broadest sexual-content signal — it catches anything sexually charged, from implied to explicit. When in doubt, choose x.
  - Choose x when the positive prompt requests any of the following:
    - Sexually suggestive posing (spread legs, ahegao, sticking tongue out, seductive look)
    - Revealing clothing in a sexualized context (lingerie + bedroom, bikini + sexy pose, see-through outfits, micro-clothing)
    - Sensual narrative (seductive, alluring, sexy, erotic, suggestive, sensual, lewd, lust, ecstasy, moaning, hot)
    - Implied sex (couple in bed undressed, post-sex, afterglow, foreplay)
    - Any content that qualifies as explicit (nudity, visible genitals, depicted sex acts) — explicit is a subset of suggestive
  - Medical, anatomical, or biological descriptions without sexual framing are sec.
  - Swimwear, exposed shoulders, partial clothing in non-sexual contexts (beach, sport, swimsuit competition, athletic wear, modest fashion) are sec.
  - Standard portraiture, fashion, glamour photography without explicit sexual framing is sec.
  - For this binary check, only use x or sec.`;

const SUGGESTIVE_G = `- x: Civitai Prompt Suggestive
  - Classify based on these examples:
  - "1girl, bikini, beach, sexy pose, alluring expression" → x
  - "1girl, lingerie, bedroom, sensual" → x
  - "1girl, nude, explicit, masturbation" → x (explicit is also suggestive)
  - "1girl, micro-bikini, suggestive pose" → x
  - "couple in bed, undressed, post-sex glow" → x
  - "1girl, see-through dress, provocative" → x
  - "1girl, business suit, professional portrait" → sec
  - "1girl, swimsuit, competitive swimming pool" → sec
  - "anatomical diagram of female reproductive system" → sec
  - "fashion shoot, runway, designer dress" → sec
  - "1girl, beautiful, professional photo" → sec
  - For this binary check, only use x or sec.`;

const SUGGESTIVE_H = `- x: Civitai Prompt Suggestive
  - Default to x when ANY sexual or sensual signal is present in the positive prompt. This label is intentionally broad.
  - Choose sec ONLY when the positive prompt has no plausible sexual signal: standard portraiture, fashion, professional context, medical/anatomical, sport/athletic, news/documentary, or other clearly non-sexual framing.
  - These are NOT sufficient to choose sec: appearance descriptors like "beautiful, pretty, gorgeous, attractive" — those can co-occur with sexual context.
  - For this binary check, only use x or sec.`;

// ============================================================================
// EXPLICIT CANDIDATES
// ============================================================================
// OptionA / OptionB / OptionAB were string-replacement deltas on a shared base.
// I expand each into a self-contained policy below.

const EXPLICIT_OPTION_A = `- x: Civitai Prompt Explicit
  - Choose x when the prompt requests explicit sexual content: visible genitals (pussy, penis, anus, vulva), visible nipples in sexualized framing, depicted sex acts (masturbation, intercourse, oral sex, anal sex), explicit sexual fluids (cum, ejaculation, squirting), or unambiguous nudity depicted in a sexual manner.
  - Only the POSITIVE prompt counts. Explicit terms appearing ONLY in the negative prompt are avoidance signals (the user is asking those NOT to appear) and are sec for this label regardless of how many such terms are listed there.
  - Suggestive content WITHOUT explicit elements is sec for THIS label. Implied sex, lingerie, sensual posing, revealing clothing without visible genitals or depicted acts is sec.
  - Lingerie, swimwear, revealing clothing, sensual posing without exposed genitals or depicted sex acts is sec.
  - Topless or artistic nudity without sexualized framing is sec.
  - Anthropomorphic characters (anthro, furry, dog girl, cat girl, kemono, monster girl, demi-human, slime girl, dragon girl, kemonomimi, fox girl) without depicted sex acts, visible genitals, or sexual fluids are sec for this label. A non-human or partially-non-human body form does not by itself indicate explicit content.
  - Example x: "1girl, nude, spread legs, pussy visible" → x
  - Example x: "explicit sex scene, vaginal penetration, cum" → x
  - Example sec: "1girl, bikini. NEGATIVE: nude, pussy, penis, cum" → sec
  - Example sec: "1girl, lingerie, bedroom, sensual pose" → sec
  - Example sec: "1girl, bikini, beach, alluring" → sec
  - Example sec: "anthro badger, fur, claw hands, standing" → sec
  - Example sec: "cat girl, cat ears, cat tail, park, looking at viewer" → sec
  - For this binary check, only use x or sec.`;

const EXPLICIT_OPTION_B = `- x: Civitai Prompt Explicit
  - Choose x when the prompt requests explicit sexual content: visible genitals (pussy, penis, anus, vulva), visible nipples in sexualized framing, depicted sex acts (masturbation, intercourse, oral sex, anal sex), explicit sexual fluids (cum, ejaculation, squirting), or unambiguous nudity depicted in a sexual manner.
  - Only the POSITIVE prompt counts. Explicit terms appearing ONLY in the negative prompt are avoidance signals (the user is asking those NOT to appear) and are sec for this label regardless of how many such terms are listed there.
  - Suggestive content WITHOUT explicit elements is sec for THIS label. Implied sex, lingerie, sensual posing, revealing clothing without visible genitals or depicted acts is sec.
  - Body-shape descriptors alone (large breasts, huge breasts, thick thighs, cleavage, wide hips, curvy, hourglass, toned, muscular, slim waist) — without visible genitals, depicted sex acts, or nudity — are sec for this label, even when paired with revealing-but-still-clothed attire (lingerie, swimwear, leotard, crop tops, shorts, bikini, bra+bikini, micro-skirts). Nudity itself remains explicit-triggering when present; this rule only carves out cases where the body is described as curvy or shapely but is shown clothed.
  - Lingerie, swimwear, revealing clothing, sensual posing without exposed genitals or depicted sex acts is sec.
  - Topless or artistic nudity without sexualized framing is sec.
  - Example sec: "1girl, huge breasts, thick thighs, blue dress, sitting" → sec
  - Example sec: "athletic woman, toned body, gym shorts, sports bra, gym" → sec
  - Example sec: "starfire, large breasts, cleavage, purple dress" → sec
  - For this binary check, only use x or sec.`;

const EXPLICIT_OPTION_AB = `- x: Civitai Prompt Explicit
  - Choose x when the prompt requests explicit sexual content: visible genitals (pussy, penis, anus, vulva), visible nipples in sexualized framing, depicted sex acts (masturbation, intercourse, oral sex, anal sex), explicit sexual fluids (cum, ejaculation, squirting), or unambiguous nudity depicted in a sexual manner.
  - Only the POSITIVE prompt counts. Explicit terms appearing ONLY in the negative prompt are avoidance signals (the user is asking those NOT to appear) and are sec for this label regardless of how many such terms are listed there.
  - Suggestive content WITHOUT explicit elements is sec for THIS label. Implied sex, lingerie, sensual posing, revealing clothing without visible genitals or depicted acts is sec.
  - Body-shape descriptors alone (large breasts, huge breasts, thick thighs, cleavage, wide hips, curvy, hourglass, toned, muscular, slim waist) — without visible genitals, depicted sex acts, or nudity — are sec for this label, even when paired with revealing-but-still-clothed attire (lingerie, swimwear, leotard, crop tops, shorts, bikini, bra+bikini, micro-skirts). Nudity itself remains explicit-triggering when present; this rule only carves out cases where the body is described as curvy or shapely but is shown clothed.
  - Lingerie, swimwear, revealing clothing, sensual posing without exposed genitals or depicted sex acts is sec.
  - Topless or artistic nudity without sexualized framing is sec.
  - Anthropomorphic characters (anthro, furry, dog girl, cat girl, kemono, monster girl, demi-human, slime girl, dragon girl, kemonomimi, fox girl) without depicted sex acts, visible genitals, or sexual fluids are sec for this label.
  - Example sec: "1girl, huge breasts, thick thighs, blue dress, sitting" → sec
  - Example sec: "athletic woman, toned body, gym shorts, sports bra, gym" → sec
  - Example sec: "starfire, large breasts, cleavage, purple dress" → sec
  - Example sec: "anthro badger, fur, claw hands, standing" → sec
  - For this binary check, only use x or sec.`;

const EXPLICIT_CANDIDATE_A = `- x: Civitai Prompt Explicit
  - Default to sec. Choose x ONLY when the prompt contains at least one literal explicit-anatomy term (pussy, penis, vagina, vulva, anus, clitoris, scrotum, testicles, glans) OR a literal depicted-sex-act term (intercourse, penetration, vaginal sex, anal sex, oral sex, masturbation, masturbating, blowjob, handjob, fingering, cunnilingus, fellatio, fucking, cumshot, creampie, bukkake) OR explicit fluid term (cum, semen, ejaculation, ejaculating, squirting) in the positive prompt.
  - Suggestive content WITHOUT one of the literal terms above is sec for THIS label.
  - Lingerie, swimwear, revealing clothing, sensual posing alone is sec.
  - "Nude" / "naked" alone (without visible genitals or depicted acts) is sec for this label — artistic nudity isn't necessarily explicit.
  - Topless or artistic nudity without sexualized framing (classical art, life drawing, medical) is sec.
  - For this binary check, only use x or sec.`;

const EXPLICIT_CANDIDATE_B = `- x: Civitai Prompt Explicit
  - Choose x when the prompt requests explicit sexual content: visible genitals (pussy, penis, anus, vulva), visible nipples in sexualized framing, depicted sex acts (masturbation, intercourse, oral sex, anal sex), explicit sexual fluids (cum, ejaculation, squirting), or unambiguous nudity depicted in a sexual manner.
  - This label is for hardcore content only. The Suggestive label covers everything sexually-charged-but-not-explicit; Explicit covers only the subset that crosses into visible sexual anatomy or depicted sex acts. If a prompt is sexually-charged but does NOT depict visible genitals or sex acts, it belongs in Suggestive — classify as sec for Explicit.
  - Lingerie, swimwear, revealing clothing, sensual posing without exposed genitals or depicted sex acts is sec (handled by Suggestive).
  - Implied sex, "they have sex" without depicted acts, romantic but not graphic scenes are sec for Explicit.
  - Topless or artistic nudity without sexualized framing (classical art reference, life drawing, medical) is sec.
  - For this binary check, only use x or sec.`;

const EXPLICIT_CANDIDATE_C = `- x: Civitai Prompt Explicit
  - Choose x when the prompt requests explicit sexual content: visible genitals (pussy, penis, anus, vulva), visible nipples in sexualized framing, depicted sex acts (masturbation, intercourse, oral sex, anal sex), explicit sexual fluids (cum, ejaculation, squirting), or unambiguous nudity depicted in a sexual manner.
  - Only the POSITIVE prompt counts. Explicit terms appearing ONLY in the negative prompt are avoidance signals (the user is asking those NOT to appear) and are sec for this label regardless of how many such terms are listed there.
  - Suggestive content WITHOUT explicit elements is sec for THIS label. Implied sex, lingerie, sensual posing, revealing clothing without visible genitals or depicted acts is sec.
  - Lingerie, swimwear, revealing clothing, sensual posing without exposed genitals or depicted sex acts is sec.
  - Topless or artistic nudity without sexualized framing is sec.
  - For this binary check, only use x or sec.`;

const EXPLICIT_CANDIDATE_E = `- x: Civitai Prompt Explicit
  - Choose x when the positive prompt requests explicit sexual content with at least one of: visible genitals, depicted sex acts (intercourse, oral, anal, masturbation), explicit sexual fluids (cum, ejaculation, squirting), or unambiguous nudity in a clearly sexualized framing.
  - Suggestive content WITHOUT explicit elements (lingerie, sensual posing, revealing clothing alone) is sec for this label.
  - For this binary check, only use x or sec.`;

const EXPLICIT_CANDIDATE_F = `- x: Civitai Prompt Explicit
  - This label flags hardcore sexual content for stronger moderation actions. When the positive prompt unambiguously requests explicit hardcore content, choose x.
  - Choose x when the positive prompt requests any of the following:
    - Visible genitals (pussy, penis, anus, vulva, vagina, clitoris)
    - Visible nipples in a sexualized framing
    - Depicted sex acts (intercourse, masturbation, oral, anal, fingering, blowjob, handjob)
    - Explicit sexual fluids (cum, semen, ejaculation, ejaculating, squirting, creampie, cumshot, bukkake)
    - Unambiguous nudity depicted in a clearly sexual manner (spread legs, sexual posing with visible genitals)
    - Hentai or pornographic art descriptors paired with the above
  - Suggestive content alone (lingerie, sensual posing, revealing clothing without visible genitals or depicted acts) is sec for THIS label — it belongs in Suggestive.
  - Topless or artistic nudity without sexualized framing (classical art, life drawing, medical) is sec.
  - For this binary check, only use x or sec.`;

const EXPLICIT_CANDIDATE_G = `- x: Civitai Prompt Explicit
  - Classify based on these examples:
  - "1girl, nude, spread legs, pussy visible, masturbating" → x
  - "explicit sex scene, vaginal penetration, cum" → x
  - "1boy, erect penis, cumshot" → x
  - "blowjob, oral sex, deepthroat" → x
  - "anal sex, double penetration" → x
  - "creampie, cum dripping" → x
  - "bukkake, multiple cum shots on face" → x
  - "1girl, lingerie, bedroom, sensual pose" → sec
  - "1girl, bikini, beach, alluring" → sec
  - "topless figure study, classical art" → sec
  - "1girl, nude, classical pose, statue" → sec
  - "couple in bed, kissing, romantic" → sec
  - For this binary check, only use x or sec.`;

const EXPLICIT_CANDIDATE_H = `- x: Civitai Prompt Explicit
  - Default to sec for this label. Most sexual content is Suggestive, not Explicit; this label is specifically for the hardcore subset.
  - Choose x ONLY when the positive prompt clearly requests at least one of:
    - Visible genital anatomy described or named (pussy, penis, anus, vulva, vagina)
    - A depicted sex act with anatomical specificity (intercourse, masturbation, oral, anal, fingering)
    - Explicit sexual fluid in a sexual context (cum, ejaculation, squirting, creampie)
    - Spread legs or anatomical-exposure pose paired with explicit framing
  - These are NOT sufficient on their own: implied sex, "having sex" without depicted acts, romantic narrative, lingerie, swimwear, sensual posing, revealing clothing, kissing, "nude" with no further detail.
  - For this binary check, only use x or sec.`;

// ============================================================================
// Extra candidate list (everything that isn't the live shipped policy).
// ============================================================================

type ExtraCandidate = {
  label: string;
  name: string;
  threshold: number;
  archived: boolean;
  notes: string;
  policy: string;
};

const EXTRA_PROMPT_CANDIDATES: ExtraCandidate[] = [
  // ----- Young -----
  {
    label: 'Young',
    name: 'Option 4 — adult-anchor override (legacy)',
    threshold: 0.5,
    archived: true,
    notes:
      'Earliest viable Young rev with an explicit adult-anchor override. Single-pass "x when youth term, sec when adult age" with anthro and franchise carve-outs. Superseded by Option 9 bucket framing.',
    policy: YOUNG_OPTION_4,
  },
  {
    label: 'Young',
    name: 'Option 5 — primary-rule trigger list (legacy)',
    threshold: 0.5,
    archived: true,
    notes:
      'Trigger-on-any-term primary rule with whole-word matching. Anthro carve-out was weaker than Option 6 — descriptors like "young", "petite", "cute" could override it. Iterated forward into Option 6.',
    policy: YOUNG_OPTION_5,
  },
  {
    label: 'Young',
    name: 'Option 6 — tighter sec carve-outs (legacy)',
    threshold: 0.5,
    archived: true,
    notes:
      'Pre-bucket-framing iteration. Extended the "young + adult-noun" carve-out and tightened the anthro carve-out so soft descriptors (petite, cute, chibi) don\'t override it. Still suffered from the YOUNG-ADULT-vs-CHILD ambiguity Option 9 resolved.',
    policy: YOUNG_OPTION_6,
  },
  {
    label: 'Young',
    name: 'Option 7 — reasoning-first prose policy (legacy)',
    threshold: 0.5,
    archived: true,
    notes:
      'Rewrites the rules in a prose / decision-tree form instead of bullets. Hypothesis: more readable for the model. Result didn\'t outperform Option 9 in TPs/FPs.',
    policy: YOUNG_OPTION_7,
  },
  {
    label: 'Young',
    name: 'Option 8 — ultra-minimalist (legacy)',
    threshold: 0.5,
    archived: true,
    notes:
      'Stripped-down minimalist version testing whether the model can do the right thing with less guidance. Slightly worse than Option 9 — model needs the carve-outs to avoid common FPs.',
    policy: YOUNG_OPTION_8,
  },
  {
    label: 'Young',
    name: 'Option 10 — emphatic dispositive overrides (legacy)',
    threshold: 0.5,
    archived: true,
    notes:
      'Option 9 + dispositive sec overrides for adult-anchor, anthro/furry, "young X" adult vocab, and franchise-name false-positives. Stronger language around what wins ties. Lost to Option 11 on the empathy-stack evasion pattern.',
    policy: YOUNG_OPTION_10,
  },
  {
    label: 'Young',
    name: 'Option 11 — emphasis-stack pattern (additive on Option 9)',
    threshold: 0.4,
    archived: true,
    notes:
      'Option 9 + a new EMPHASIS-STACK PATTERN rule per moderator feedback. Targets prompts where every individual descriptor has a sec carve-out but the combination — emphasis on "young" + multiple body descriptors + person tag — signals intent to depict a minor. Hold-off-shipping pending evasion examples in the test corpus.',
    policy: YOUNG_OPTION_11,
  },

  // ----- Suggestive -----
  {
    label: 'Suggestive',
    name: 'Candidate A — non-sexual-fashion carve-out',
    threshold: 0.5,
    archived: true,
    notes:
      'Live policy + explicit carve-out for non-sexual fashion contexts (modeling, runway, editorial). Targets FPs from fashion-shoot prompts that read sexual to the model but aren\'t.',
    policy: SUGGESTIVE_A,
  },
  {
    label: 'Suggestive',
    name: 'Candidate B — tighter threshold language',
    threshold: 0.5,
    archived: true,
    notes:
      'Live policy + requirement that at least one explicit sexually-charged term be present. Generic appearance descriptors (beautiful, gorgeous) alone don\'t qualify.',
    policy: SUGGESTIVE_B,
  },
  {
    label: 'Suggestive',
    name: 'Candidate C — negative-prompt awareness',
    threshold: 0.5,
    archived: true,
    notes:
      'Live policy + explicit rule that sexual terms appearing only in the negative prompt are avoidance signals, not requests.',
    policy: SUGGESTIVE_C,
  },
  {
    label: 'Suggestive',
    name: 'Candidate E — minimal (shape study)',
    threshold: 0.5,
    archived: true,
    notes:
      'Shape study: one trigger + one carve-out, no examples. Tests how much guidance the model actually needs.',
    policy: SUGGESTIVE_E,
  },
  {
    label: 'Suggestive',
    name: 'Candidate F — TP-heavy / broad trigger list',
    threshold: 0.5,
    archived: true,
    notes:
      'Shape study: severity preamble + broader trigger list. Tilted toward TPs at the cost of FPs.',
    policy: SUGGESTIVE_F,
  },
  {
    label: 'Suggestive',
    name: 'Candidate G — few-shot only',
    threshold: 0.5,
    archived: true,
    notes:
      'Shape study: no rule bullets, just example prompts. Tests whether examples alone are enough.',
    policy: SUGGESTIVE_G,
  },
  {
    label: 'Suggestive',
    name: 'Candidate H — polarity inversion',
    threshold: 0.5,
    archived: true,
    notes:
      'Shape study: defaults to x for any sexual signal, requires clearly non-sexual context for sec. Inverted from the standard "default sec".',
    policy: SUGGESTIVE_H,
  },

  // ----- Explicit -----
  {
    label: 'Explicit',
    name: 'Option A — live + anthro carve-out',
    threshold: 0.3,
    archived: true,
    notes:
      'Live Explicit + anthropomorphic-character carve-out (anthro/furry/kemono/etc. without depicted acts → sec).',
    policy: EXPLICIT_OPTION_A,
  },
  {
    label: 'Explicit',
    name: 'Option B — live + body-shape-alone carve-out',
    threshold: 0.3,
    archived: true,
    notes:
      'Live Explicit + body-shape-descriptors-alone (curvy/large breasts/etc.) on clothed subjects → sec. Nudity still triggers.',
    policy: EXPLICIT_OPTION_B,
  },
  {
    label: 'Explicit',
    name: 'Option AB — live + anthro + body-shape carve-outs',
    threshold: 0.3,
    archived: true,
    notes:
      'Combined Option A + Option B. The "AB" rev with both carve-outs and threshold 0.7 is what eventually shipped as Live.',
    policy: EXPLICIT_OPTION_AB,
  },
  {
    label: 'Explicit',
    name: 'Candidate A — literal-term-required',
    threshold: 0.3,
    archived: true,
    notes:
      'Defaults to sec. Triggers only on literal explicit-anatomy / sex-act / fluid terms. "Nude" alone doesn\'t qualify.',
    policy: EXPLICIT_CANDIDATE_A,
  },
  {
    label: 'Explicit',
    name: 'Candidate B — Suggestive/Explicit boundary',
    threshold: 0.3,
    archived: true,
    notes:
      'Live policy + explicit statement that Explicit is the hardcore subset of Suggestive. Clarifies what belongs where.',
    policy: EXPLICIT_CANDIDATE_B,
  },
  {
    label: 'Explicit',
    name: 'Candidate C — negative-prompt awareness',
    threshold: 0.3,
    archived: true,
    notes:
      'Live policy + rule that explicit terms appearing only in the negative prompt are avoidance signals, not requests.',
    policy: EXPLICIT_CANDIDATE_C,
  },
  {
    label: 'Explicit',
    name: 'Candidate E — minimal (shape study)',
    threshold: 0.3,
    archived: true,
    notes: 'Shape study: one trigger + one carve-out, no examples.',
    policy: EXPLICIT_CANDIDATE_E,
  },
  {
    label: 'Explicit',
    name: 'Candidate F — TP-heavy / broad trigger list',
    threshold: 0.3,
    archived: true,
    notes: 'Shape study: severity preamble + broader trigger list.',
    policy: EXPLICIT_CANDIDATE_F,
  },
  {
    label: 'Explicit',
    name: 'Candidate G — few-shot only',
    threshold: 0.3,
    archived: true,
    notes: 'Shape study: examples only, no rule bullets.',
    policy: EXPLICIT_CANDIDATE_G,
  },
  {
    label: 'Explicit',
    name: 'Candidate H — polarity inversion',
    threshold: 0.3,
    archived: true,
    notes:
      'Shape study: defaults to sec, requires explicit anatomy or named act for x. Inverted from "trigger when explicit".',
    policy: EXPLICIT_CANDIDATE_H,
  },
];

// ============================================================================

async function loadExport(path: string): Promise<ExportPayload> {
  if (!existsSync(path)) {
    throw new Error(
      `Bulk export file not found: ${path}\n` +
        `Run: node .claude/skills/xguard-manager/manage.mjs export -o ${path}`
    );
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as ExportPayload;
}

async function seedLive(
  mode: ScannerPolicyMode,
  labels: ExportLabel[]
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  for (const l of labels) {
    const existing = await listCandidates({ mode, label: l.name });
    if (existing.some((c) => c.name === 'Live')) {
      skipped++;
      continue;
    }
    const input: UpsertCandidateInput = {
      name: 'Live',
      mode,
      label: l.name,
      threshold: l.threshold,
      archived: false,
      active: false,
      policy: l.policy,
      notes:
        `Currently-shipped xguard policy for ${l.name} (${mode} mode), ` +
        `action=${l.action}. Seeded ${new Date().toISOString().split('T')[0]}.`,
    };
    await upsertCandidate(input, SEED_USER_ID);
    inserted++;
    console.log(`  + ${mode} / ${l.name} — Live (live, ${l.threshold})`);
  }
  return { inserted, skipped };
}

async function seedExtras(): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  for (const extra of EXTRA_PROMPT_CANDIDATES) {
    const existing = await listCandidates({ mode: 'prompt', label: extra.label });
    if (existing.some((c) => c.name === extra.name)) {
      skipped++;
      continue;
    }
    await upsertCandidate(
      {
        name: extra.name,
        mode: 'prompt',
        label: extra.label,
        threshold: extra.threshold,
        archived: extra.archived,
        active: false,
        policy: extra.policy,
        notes: extra.notes,
      },
      SEED_USER_ID
    );
    inserted++;
    console.log(
      `  + prompt / ${extra.label} — ${extra.name} (${extra.archived ? 'archived' : 'active-eligible'}, ${extra.threshold})`
    );
  }
  return { inserted, skipped };
}

/**
 * One-time migration: convert any sysRedis candidate records that still carry
 * the legacy `status` field over to the new `archived` boolean. Bypasses the
 * typed service because the schema no longer accepts `status`, which would
 * cause `listCandidates` to silently drop these rows before we could fix
 * them. Idempotent — already-migrated records pass through untouched.
 */
async function migrateStatusToArchived(): Promise<number> {
  const all = await sysRedis.packed.hGetAll<Record<string, unknown>>(
    REDIS_SYS_KEYS.SCANNER_POLICY.CANDIDATES
  );
  let migrated = 0;
  for (const [field, raw] of Object.entries(all ?? {})) {
    if (!raw || typeof raw !== 'object') continue;
    const rec = raw as Record<string, unknown>;
    if (typeof rec.archived === 'boolean' && !('status' in rec)) continue; // already migrated
    const legacyStatus = typeof rec.status === 'string' ? rec.status : null;
    const archived = legacyStatus === 'archived';
    const next = { ...rec, archived };
    delete (next as Record<string, unknown>).status;
    await sysRedis.packed.hSet(REDIS_SYS_KEYS.SCANNER_POLICY.CANDIDATES, field, next);
    migrated++;
  }
  return migrated;
}

async function main() {
  const path = process.argv[2] ?? 'C:/temp/_xg-export.json';
  console.log(`Loading xguard export from ${path}`);
  const payload = await loadExport(path);

  console.log('\nMigrating legacy `status` field → `archived` boolean (idempotent):');
  const migrated = await migrateStatusToArchived();
  console.log(`  migrated ${migrated} record(s)`);

  console.log('\nSeeding prompt-mode live policies:');
  const promptResult = await seedLive('prompt', payload.prompt?.labels ?? []);

  console.log('\nSeeding text-mode live policies:');
  const textResult = await seedLive('text', payload.text?.labels ?? []);

  console.log('\nSeeding extra prompt-mode candidates from this session:');
  const extraResult = await seedExtras();

  const total = promptResult.inserted + textResult.inserted + extraResult.inserted;
  const skipped = promptResult.skipped + textResult.skipped + extraResult.skipped;
  console.log(`\nDone. Inserted ${total}, skipped (already present) ${skipped}.`);
  console.log('Re-run anytime — the script is idempotent (skips on duplicate name).');
  process.exit(0);
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
