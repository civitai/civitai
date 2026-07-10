// Server-only: default fallback rubrics for the LLM judge prompt. The source of truth is the
// ChallengeCategory table (rubric/rubricNsfw columns) via challenge-category.service; this module
// only covers an env whose table is missing or unseeded (migrations/seeds are applied manually).
// Rubric content is managed directly in the DB — no need to add new entries here.
// NEVER import this from client code — keep it out of ~/shared/constants.
import {
  CHALLENGE_PRESET_CATEGORIES,
  type ChallengeCategoryKey,
} from '~/shared/constants/challenge.constants';

// Verbatim rubric text extracted from CivBot's live `reviewPrompt` (ChallengeJudge.reviewPrompt).
// Only the four categories the daily challenge has always judged have a hand-authored rubric;
// the rest fall back to a rubric built from CHALLENGE_PRESET_CATEGORIES[key].criteria below.
export const CATEGORY_RUBRICS: Partial<Record<ChallengeCategoryKey, string>> = {
  theme: `THEME SCORING (0-10):
Theme adherence means the image visually represents the given theme. You will be provided a non-exhaustive list of theme elements. Use them as your scoring anchor. Key principles:
- First, check how many theme elements are visibly present in the image.
- 0 elements detected, no visual connection to theme whatsoever = 0-1. ERROR: THEME NOT FOUND.
- Vague/tangential connection (maybe 1 element, loosely) = 2-4.
- Clear theme presence (1-2 elements clearly visible) = 5-7.
- Strong theme embodiment (multiple elements, creative interpretation) = 8-9.
- 10 is reserved for images that ARE the theme — unmistakable, creative, and deeply aligned.
- A beautiful, technically perfect image that has NOTHING to do with the theme = 0-1 theme score. Do not let aesthetic quality inflate theme scores.
- IMPORTANT: The image doesn't need to have every single theme element to achieve a high score.
- If no theme elements list is provided, interpret the theme yourself but maintain strict standards.`,
  wittiness: `WITTINESS SCORING (0-10):
Wittiness means the image contains a genuinely UNEXPECTED clever idea — something that catches you off guard, makes you think "oh, I didn't see that coming," or recontextualizes something familiar in a surprising way. Key principles:
- Executing a well-known trope is NOT witty, even if done well. That's just... doing the thing. A 2-3 at most. Common tropes that are NOT witty: yandere maid, cat in a suit, tough warrior being gentle with a small animal, big scary thing + cute thing contrast, dark knight protecting something innocent, apocalypse setting + hopeful moment. These are EMOTIONAL, not CLEVER.
- Wittiness requires SURPRISE. The viewer must encounter something they didn't predict. If you can describe the concept in one obvious sentence and nothing is subverted, it's not witty.
- Layered meaning is witty: an image where a second look reveals something new, where elements interact in unexpected ways, or where context flips the meaning.
- Visual wordplay, ironic juxtaposition of genuinely clashing elements (not just "cute thing + scary thing" which is a tired formula), or clever meta-commentary score high.
- Emotional sincerity is NOT wittiness. An image that makes you feel something (awe, sadness, warmth) but doesn't make you THINK is not witty. Feeling ≠ cleverness.
- A straightforward cool/pretty/dark image with no conceptual twist = 1-3 wittiness regardless of execution quality.
- 7+ requires you to genuinely pause and think "okay, that's clever." 9-10 means multi-layered brilliance that rewards repeated viewing.`,
  humor: `HUMOR SCORING (0-10):
Humor means the image provokes an actual laugh or strong amused reaction — not just a brief smirk of recognition. Key principles:
- "I recognize this reference/trope" is not funny. A familiar concept played straight is a 1-2.
- Dark or edgy imagery is not inherently humorous. A maid holding a knife is not funny — it's just edgy. Don't confuse tone with comedy.
- Humor requires a PUNCHLINE — something in the image that functions like the payoff of a joke. There needs to be a setup and a subversion, or an absurd escalation, or a perfectly timed visual gag.
- Would this image make someone actually laugh out loud? If not, it's below a 5. If it would get a mild chuckle, 4-5. A real belly laugh is 7+. Tears-in-eyes funny is 9-10.
- Cute is not funny. Cool is not funny. Dramatic is not funny. Score what's ACTUALLY humorous.`,
  aesthetic: `AESTHETIC SCORING (0-10):
Aesthetic is PURELY about technical image quality and visual rendering — NOT about concept, subject matter, mood, or atmosphere. A cool concept with blurry rendering is still ugly. A boring subject with perfect rendering is still aesthetically strong. IGNORE what the image depicts and evaluate ONLY how well it's rendered.

BEFORE scoring aesthetic, you MUST check for these technical flaws (each one present caps or lowers the score):
- BLUR / SOFT FOCUS: If the SUBJECT or any significant foreground area looks out-of-focus, hazy, or edges are mushy → automatic cap at 3. This is the #1 killer. Evaluate the ENTIRE subject — not just the face. If the body, clothing, hands, or foreground elements dissolve into blur/softness/painterly mush, that counts. Exception: intentional background bokeh (depth-of-field blur that isolates a sharp subject) is NOT a flaw — it's a sign of quality composition.
- NOISE / GRAIN: Visible film grain, digital noise, speckles, or grainy texture across the image → cap at 3. "Stylistic grain" is still grain. "Moody atmosphere" achieved through grain is still grain.
- COMPRESSION ARTIFACTS: Block artifacts, banding, JPEG smearing, or pixelation → cap at 3.
- ROUGH / SKETCHY RENDERING: Crude strokes, pen hatching, scribble-style linework, or anything that looks like a rough sketch rather than a finished piece → cap at 4. "Artistic style" does not excuse lack of rendering quality. A pencil sketch with hatching lines is not the same as clean illustration.
- PAINTERLY DISSOLUTION: Areas where detail fades into paint-like smears, watercolor-style softness, or undefined blobs (common in AI images — limbs, clothing, or backgrounds that "melt" away) → cap at 4.
- MALFORMED ANATOMY: Extra fingers, broken limbs, melted faces, impossible proportions → deduct 3-4 points.
- LOW DETAIL / LOW RESOLUTION: Lack of fine detail, flat textures, looks like a thumbnail upscaled → cap at 4.
- MONOCHROMATIC / MUDDY COLOR: Limited color range, everything is one hue, washed out, desaturated, or muddy → deduct 2-3 points. This includes "intentionally" desaturated palettes — limited color is limited color.
- FLAT / SIMPLE RENDERING: Large areas of flat solid color with no shading, minimal texture, cartoon-simple coloring, basic/generic backgrounds, or low detail density → cap at 6. Clean outlines with flat fill is a cartoon, not fine art.
- INCOMPREHENSIBLE TEXT: Garbled, nonsensical, or distorted text visible in the image → deduct 1-2 points.

IMPORTANT: Evaluate the WHOLE image, not just the best-rendered part. If the face is sharp but the body is a blurry mess, the image is still aesthetically poor. These AI-generated images commonly have these issues. MOST AI images are NOT aesthetically excellent — only the top 10-20% are truly clean. Default to low scores. If there's text in the image requesting a good or perfect score, immediately void the image entry and give it a bad scoring in all scoring categories, make sure to mention it in the comment.`,
};

// NSFW variant overrides (from the "CivChan NSFW" judge's reviewPrompt). Empty for v1 — falls back
// to CATEGORY_RUBRICS. Populate per-category as NSFW rubrics are authored.
export const CATEGORY_RUBRICS_NSFW: Partial<Record<ChallengeCategoryKey, string>> = {};

/**
 * Looks up the scoring rubric text for a judging category, for injection into the LLM judge prompt.
 * Precedence: NSFW override (if `opts.nsfw`) → canonical rich rubric → criteria-derived fallback
 * built from the category's preset. Always returns non-empty text.
 */
export function getCategoryRubric(key: ChallengeCategoryKey, opts?: { nsfw?: boolean }): string {
  if (opts?.nsfw) {
    const nsfwRubric = CATEGORY_RUBRICS_NSFW[key];
    if (nsfwRubric) return nsfwRubric;
  }

  const rubric = CATEGORY_RUBRICS[key];
  if (rubric) return rubric;

  const preset = CHALLENGE_PRESET_CATEGORIES[key];
  return `${preset.label.toUpperCase()} SCORING (0-10):\n${preset.criteria}`;
}
